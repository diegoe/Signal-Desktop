// Copyright 2020-2021 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

/* eslint-disable @typescript-eslint/ban-types */
/* eslint-disable no-bitwise */
/* eslint-disable class-methods-use-this */
/* eslint-disable more/no-then */
/* eslint-disable camelcase */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable max-classes-per-file */

import { isNumber, map, omit, noop } from 'lodash';
import PQueue from 'p-queue';
import { v4 as getGuid } from 'uuid';

import { SessionCipherClass, SignalProtocolAddressClass } from '../libsignal.d';
import { BatcherType, createBatcher } from '../util/batcher';
import { assert } from '../util/assert';

import EventTarget from './EventTarget';
import { WebAPIType } from './WebAPI';
import utils from './Helpers';
import WebSocketResource, {
  IncomingWebSocketRequest,
} from './WebsocketResources';
import Crypto from './Crypto';
import { deriveMasterKeyFromGroupV1 } from '../Crypto';
import { ContactBuffer, GroupBuffer } from './ContactsParser';
import { IncomingIdentityKeyError } from './Errors';
import {
  createCertificateValidator,
  SecretSessionCipher,
} from '../metadata/SecretSessionCipher';

import {
  AttachmentPointerClass,
  CallingMessageClass,
  DataMessageClass,
  DownloadAttachmentType,
  EnvelopeClass,
  ReceiptMessageClass,
  SyncMessageClass,
  TypingMessageClass,
  UnprocessedType,
  VerifiedClass,
} from '../textsecure.d';

import { WebSocket } from './WebSocket';

import { deriveGroupFields, MASTER_KEY_LENGTH } from '../groups';

const GROUPV1_ID_LENGTH = 16;
const GROUPV2_ID_LENGTH = 32;
const RETRY_TIMEOUT = 2 * 60 * 1000;

type SessionResetsType = Record<string, number>;

declare global {
  // We want to extend `Event`, so we need an interface.
  // eslint-disable-next-line no-restricted-syntax
  interface Event {
    code?: string | number;
    configuration?: any;
    confirm?: () => void;
    contactDetails?: any;
    count?: number;
    data?: any;
    deliveryReceipt?: any;
    error?: any;
    eventType?: string | number;
    groupDetails?: any;
    groupId?: string;
    groupV2Id?: string;
    messageRequestResponseType?: number | null;
    proto?: any;
    read?: any;
    reason?: any;
    sender?: any;
    senderDevice?: any;
    senderUuid?: any;
    source?: any;
    sourceUuid?: any;
    stickerPacks?: any;
    threadE164?: string | null;
    threadUuid?: string | null;
    storageServiceKey?: ArrayBuffer;
    timestamp?: any;
    typing?: any;
    verified?: any;
  }
  // We want to extend `Error`, so we need an interface.
  // eslint-disable-next-line no-restricted-syntax
  interface Error {
    reason?: any;
    stackForLog?: string;
    sender?: SignalProtocolAddressClass;
    senderUuid?: SignalProtocolAddressClass;
  }
}

type CacheAddItemType = {
  envelope: EnvelopeClass;
  data: UnprocessedType;
  request: IncomingWebSocketRequest;
};

type CacheUpdateItemType = {
  id: string;
  data: Partial<UnprocessedType>;
};

class MessageReceiverInner extends EventTarget {
  _onClose?: (ev: any) => Promise<void>;

  appQueue: PQueue;

  cacheAddBatcher: BatcherType<CacheAddItemType>;

  cacheRemoveBatcher: BatcherType<string>;

  cacheUpdateBatcher: BatcherType<CacheUpdateItemType>;

  calledClose?: boolean;

  count: number;

  processedCount: number;

  deviceId?: number;

  hasConnected?: boolean;

  incomingQueue: PQueue;

  isEmptied?: boolean;

  number_id?: string;

  password: string;

  pendingQueue: PQueue;

  retryCachedTimeout: any;

  server: WebAPIType;

  serverTrustRoot: ArrayBuffer;

  signalingKey: ArrayBuffer;

  socket?: WebSocket;

  stoppingProcessing?: boolean;

  username: string;

  uuid: string;

  uuid_id?: string;

  wsr?: WebSocketResource;

  constructor(
    oldUsername: string,
    username: string,
    password: string,
    signalingKey: ArrayBuffer,
    options: {
      serverTrustRoot: string;
    }
  ) {
    super();

    this.count = 0;
    this.processedCount = 0;

    this.signalingKey = signalingKey;
    this.username = oldUsername;
    this.uuid = username;
    this.password = password;
    this.server = window.WebAPI.connect({
      username: username || oldUsername,
      password,
    });

    if (!options.serverTrustRoot) {
      throw new Error('Server trust root is required!');
    }
    this.serverTrustRoot = MessageReceiverInner.stringToArrayBufferBase64(
      options.serverTrustRoot
    );

    this.number_id = oldUsername
      ? utils.unencodeNumber(oldUsername)[0]
      : undefined;
    this.uuid_id = username ? utils.unencodeNumber(username)[0] : undefined;
    this.deviceId =
      username || oldUsername
        ? parseInt(utils.unencodeNumber(username || oldUsername)[1], 10)
        : undefined;

    this.incomingQueue = new PQueue({ concurrency: 1, timeout: 1000 * 60 * 2 });
    this.pendingQueue = new PQueue({ concurrency: 1, timeout: 1000 * 60 * 2 });
    this.appQueue = new PQueue({ concurrency: 1, timeout: 1000 * 60 * 2 });

    this.cacheAddBatcher = createBatcher<CacheAddItemType>({
      wait: 200,
      maxSize: 30,
      processBatch: this.cacheAndQueueBatch.bind(this),
    });
    this.cacheUpdateBatcher = createBatcher<CacheUpdateItemType>({
      wait: 500,
      maxSize: 30,
      processBatch: this.cacheUpdateBatch.bind(this),
    });
    this.cacheRemoveBatcher = createBatcher<string>({
      wait: 500,
      maxSize: 30,
      processBatch: this.cacheRemoveBatch.bind(this),
    });

    this.cleanupSessionResets();
  }

  static stringToArrayBuffer = (string: string): ArrayBuffer =>
    window.dcodeIO.ByteBuffer.wrap(string, 'binary').toArrayBuffer();

  static arrayBufferToString = (arrayBuffer: ArrayBuffer): string =>
    window.dcodeIO.ByteBuffer.wrap(arrayBuffer).toString('binary');

  static stringToArrayBufferBase64 = (string: string): ArrayBuffer =>
    window.dcodeIO.ByteBuffer.wrap(string, 'base64').toArrayBuffer();

  static arrayBufferToStringBase64 = (arrayBuffer: ArrayBuffer): string =>
    window.dcodeIO.ByteBuffer.wrap(arrayBuffer).toString('base64');

  connect() {
    if (this.calledClose) {
      return;
    }

    // We always process our cache before processing a new websocket message
    this.pendingQueue.add(async () => this.queueAllCached());

    this.count = 0;
    if (this.hasConnected) {
      const ev = new Event('reconnect');
      this.dispatchEvent(ev);
    }

    this.isEmptied = false;

    this.hasConnected = true;

    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close();
      if (this.wsr) {
        this.wsr.close();
      }
    }
    // initialize the socket and start listening for messages
    this.socket = this.server.getMessageSocket();
    this.socket.onclose = this.onclose.bind(this);
    this.socket.onerror = this.onerror.bind(this);
    this.socket.onopen = this.onopen.bind(this);
    this.wsr = new WebSocketResource(this.socket, {
      handleRequest: this.handleRequest.bind(this),
      keepalive: {
        path: '/v1/keepalive',
        disconnect: true,
      },
    });

    // Because sometimes the socket doesn't properly emit its close event
    this._onClose = this.onclose.bind(this);
    if (this._onClose) {
      this.wsr.addEventListener('close', this._onClose);
    }
  }

  async stopProcessing() {
    window.log.info('MessageReceiver: stopProcessing requested');
    this.stoppingProcessing = true;
    return this.close();
  }

  unregisterBatchers() {
    window.log.info('MessageReceiver: unregister batchers');
    this.cacheAddBatcher.unregister();
    this.cacheUpdateBatcher.unregister();
    this.cacheRemoveBatcher.unregister();
  }

  shutdown() {
    if (this.socket) {
      this.socket.onclose = noop;
      this.socket.onerror = noop;
      this.socket.onopen = noop;

      this.socket = undefined;
    }

    if (this.wsr) {
      if (this._onClose) {
        this.wsr.removeEventListener('close', this._onClose);
      }
      this.wsr = undefined;
    }
  }

  async close() {
    window.log.info('MessageReceiver.close()');
    this.calledClose = true;

    // Our WebSocketResource instance will close the socket and emit a 'close' event
    //   if the socket doesn't emit one quickly enough.
    if (this.wsr) {
      this.wsr.close(3000, 'called close');
    }

    this.clearRetryTimeout();

    return this.drain();
  }

  onopen() {
    window.log.info('websocket open');
  }

  onerror() {
    window.log.error('websocket error');
  }

  async dispatchAndWait(event: Event) {
    this.appQueue.add(async () => Promise.all(this.dispatchEvent(event)));

    return Promise.resolve();
  }

  async onclose(ev: any) {
    window.log.info(
      'websocket closed',
      ev.code,
      ev.reason || '',
      'calledClose:',
      this.calledClose
    );

    this.shutdown();

    if (this.calledClose) {
      return Promise.resolve();
    }
    if (ev.code === 3000) {
      return Promise.resolve();
    }
    if (ev.code === 3001) {
      this.onEmpty();
    }
    // possible 403 or network issue. Make an request to confirm
    return this.server
      .getDevices()
      .then(this.connect.bind(this)) // No HTTP error? Reconnect
      .catch(async e => {
        const event = new Event('error');
        event.error = e;
        return this.dispatchAndWait(event);
      });
  }

  handleRequest(request: IncomingWebSocketRequest) {
    // We do the message decryption here, instead of in the ordered pending queue,
    // to avoid exposing the time it took us to process messages through the time-to-ack.

    if (request.path !== '/api/v1/message') {
      window.log.info('got request', request.verb, request.path);
      request.respond(200, 'OK');

      if (request.verb === 'PUT' && request.path === '/api/v1/queue/empty') {
        this.incomingQueue.add(() => {
          this.onEmpty();
        });
      }
      return;
    }

    const job = async () => {
      let plaintext;
      const headers = request.headers || [];

      if (!request.body) {
        throw new Error(
          'MessageReceiver.handleRequest: request.body was falsey!'
        );
      }

      if (headers.includes('X-Signal-Key: true')) {
        plaintext = await Crypto.decryptWebsocketMessage(
          request.body,
          this.signalingKey
        );
      } else {
        plaintext = request.body.toArrayBuffer();
      }

      try {
        const envelope = window.textsecure.protobuf.Envelope.decode(plaintext);
        window.normalizeUuids(
          envelope,
          ['sourceUuid'],
          'message_receiver::handleRequest::job'
        );
        // After this point, decoding errors are not the server's
        //   fault, and we should handle them gracefully and tell the
        //   user they received an invalid message

        if (envelope.source && this.isBlocked(envelope.source)) {
          request.respond(200, 'OK');
          return;
        }

        if (envelope.sourceUuid && this.isUuidBlocked(envelope.sourceUuid)) {
          request.respond(200, 'OK');
          return;
        }

        // Make non-private envelope IDs dashless so they don't get redacted
        //   from logs
        envelope.id = getGuid().replace(/-/g, '');
        envelope.serverTimestamp = envelope.serverTimestamp
          ? envelope.serverTimestamp.toNumber()
          : null;

        envelope.receivedAtCounter = window.Signal.Util.incrementMessageCounter();
        envelope.receivedAtDate = Date.now();

        // Calculate the message age (time on server).
        envelope.messageAgeSec = this.calculateMessageAge(
          headers,
          envelope.serverTimestamp
        );

        this.cacheAndQueue(envelope, plaintext, request);
        this.processedCount += 1;
      } catch (e) {
        request.respond(500, 'Bad encrypted websocket message');
        window.log.error(
          'Error handling incoming message:',
          e && e.stack ? e.stack : e
        );
        const ev = new Event('error');
        ev.error = e;
        await this.dispatchAndWait(ev);
      }
    };

    this.incomingQueue.add(job);
  }

  calculateMessageAge(
    headers: Array<string>,
    serverTimestamp?: number
  ): number {
    let messageAgeSec = 0; // Default to 0 in case of unreliable parameters.

    if (serverTimestamp) {
      // The 'X-Signal-Timestamp' is usually the last item, so start there.
      let it = headers.length;
      // eslint-disable-next-line no-plusplus
      while (--it >= 0) {
        const match = headers[it].match(/^X-Signal-Timestamp:\s*(\d+)\s*$/);
        if (match && match.length === 2) {
          const timestamp = Number(match[1]);

          // One final sanity check, the timestamp when a message is pulled from
          // the server should be later than when it was pushed.
          if (timestamp > serverTimestamp) {
            messageAgeSec = Math.floor((timestamp - serverTimestamp) / 1000);
          }

          break;
        }
      }
    }

    return messageAgeSec;
  }

  async addToQueue(task: () => Promise<void>) {
    this.count += 1;

    const promise = this.pendingQueue.add(task);

    const { count } = this;

    const update = () => {
      this.updateProgress(count);
    };

    promise.then(update, update);

    return promise;
  }

  hasEmptied(): boolean {
    return Boolean(this.isEmptied);
  }

  onEmpty() {
    const emitEmpty = () => {
      window.log.info("MessageReceiver: emitting 'empty' event");
      const ev = new Event('empty');
      this.dispatchEvent(ev);
      this.isEmptied = true;

      this.maybeScheduleRetryTimeout();
    };

    const waitForPendingQueue = async () => {
      window.log.info(
        "MessageReceiver: finished processing messages after 'empty', now waiting for application"
      );

      // We don't await here because we don't want this to gate future message processing
      this.appQueue.add(emitEmpty);
    };

    const waitForIncomingQueue = () => {
      this.addToQueue(waitForPendingQueue);

      // Note: this.count is used in addToQueue
      // Resetting count so everything from the websocket after this starts at zero
      this.count = 0;
    };

    const waitForCacheAddBatcher = async () => {
      await this.cacheAddBatcher.onIdle();
      this.incomingQueue.add(waitForIncomingQueue);
    };

    waitForCacheAddBatcher();
  }

  async drain() {
    const waitForIncomingQueue = async () =>
      this.addToQueue(async () => {
        window.log.info('drained');
      });

    return this.incomingQueue.add(waitForIncomingQueue);
  }

  updateProgress(count: number) {
    // count by 10s
    if (count % 10 !== 0) {
      return;
    }
    const ev = new Event('progress');
    ev.count = count;
    this.dispatchEvent(ev);
  }

  async queueAllCached() {
    const items = await this.getAllFromCache();
    const max = items.length;
    for (let i = 0; i < max; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await this.queueCached(items[i]);
    }
  }

  async queueCached(item: UnprocessedType) {
    window.log.info('MessageReceiver.queueCached', item.id);
    try {
      let envelopePlaintext: ArrayBuffer;

      if (item.envelope && item.version === 2) {
        envelopePlaintext = MessageReceiverInner.stringToArrayBufferBase64(
          item.envelope
        );
      } else if (item.envelope && typeof item.envelope === 'string') {
        envelopePlaintext = MessageReceiverInner.stringToArrayBuffer(
          item.envelope
        );
      } else {
        throw new Error(
          'MessageReceiver.queueCached: item.envelope was malformed'
        );
      }

      const envelope = window.textsecure.protobuf.Envelope.decode(
        envelopePlaintext
      );
      envelope.id = item.id;
      envelope.receivedAtCounter = item.timestamp;
      envelope.receivedAtDate = Date.now();
      envelope.source = envelope.source || item.source;
      envelope.sourceUuid = envelope.sourceUuid || item.sourceUuid;
      envelope.sourceDevice = envelope.sourceDevice || item.sourceDevice;
      envelope.serverTimestamp =
        envelope.serverTimestamp || item.serverTimestamp;

      const { decrypted } = item;
      if (decrypted) {
        let payloadPlaintext: ArrayBuffer;

        if (item.version === 2) {
          payloadPlaintext = MessageReceiverInner.stringToArrayBufferBase64(
            decrypted
          );
        } else if (typeof decrypted === 'string') {
          payloadPlaintext = MessageReceiverInner.stringToArrayBuffer(
            decrypted
          );
        } else {
          throw new Error('Cached decrypted value was not a string!');
        }
        this.queueDecryptedEnvelope(envelope, payloadPlaintext);
      } else {
        this.queueEnvelope(envelope);
      }
    } catch (error) {
      window.log.error(
        'queueCached error handling item',
        item.id,
        'removing it. Error:',
        error && error.stack ? error.stack : error
      );

      try {
        const { id } = item;
        await window.textsecure.storage.unprocessed.remove(id);
      } catch (deleteError) {
        window.log.error(
          'queueCached error deleting item',
          item.id,
          'Error:',
          deleteError && deleteError.stack ? deleteError.stack : deleteError
        );
      }
    }
  }

  getEnvelopeId(envelope: EnvelopeClass) {
    const timestamp =
      envelope && envelope.timestamp && envelope.timestamp.toNumber
        ? envelope.timestamp.toNumber()
        : null;

    if (envelope.sourceUuid || envelope.source) {
      const sender = envelope.sourceUuid || envelope.source;
      return `${sender}.${envelope.sourceDevice} ${timestamp} (${envelope.id})`;
    }

    return envelope.id;
  }

  clearRetryTimeout() {
    if (this.retryCachedTimeout) {
      clearInterval(this.retryCachedTimeout);
      this.retryCachedTimeout = null;
    }
  }

  maybeScheduleRetryTimeout() {
    if (this.isEmptied) {
      this.clearRetryTimeout();
      this.retryCachedTimeout = setTimeout(() => {
        this.pendingQueue.add(async () => this.queueAllCached());
      }, RETRY_TIMEOUT);
    }
  }

  async getAllFromCache() {
    window.log.info('getAllFromCache');
    const count = await window.textsecure.storage.unprocessed.getCount();

    if (count > 1500) {
      await window.textsecure.storage.unprocessed.removeAll();
      window.log.warn(
        `There were ${count} messages in cache. Deleted all instead of reprocessing`
      );
      return [];
    }

    const items = await window.textsecure.storage.unprocessed.getAll();
    window.log.info('getAllFromCache loaded', items.length, 'saved envelopes');

    return Promise.all(
      map(items, async item => {
        const attempts = 1 + (item.attempts || 0);

        try {
          if (attempts >= 3) {
            window.log.warn(
              'getAllFromCache final attempt for envelope',
              item.id
            );
            await window.textsecure.storage.unprocessed.remove(item.id);
          } else {
            await window.textsecure.storage.unprocessed.updateAttempts(
              item.id,
              attempts
            );
          }
        } catch (error) {
          window.log.error(
            'getAllFromCache error updating item after load:',
            error && error.stack ? error.stack : error
          );
        }

        return item;
      })
    );
  }

  async cacheAndQueueBatch(items: Array<CacheAddItemType>) {
    window.log.info('MessageReceiver.cacheAndQueueBatch', items.length);
    const dataArray = items.map(item => item.data);
    try {
      await window.textsecure.storage.unprocessed.batchAdd(dataArray);
      items.forEach(item => {
        try {
          item.request.respond(200, 'OK');
        } catch (error) {
          window.log.error(
            'cacheAndQueueBatch: Failed to send 200 to server; still queuing envelope'
          );
        }
        this.queueEnvelope(item.envelope);
      });

      this.maybeScheduleRetryTimeout();
    } catch (error) {
      window.log.error(
        'cacheAndQueue error trying to add messages to cache:',
        error && error.stack ? error.stack : error
      );

      items.forEach(item => {
        item.request.respond(500, 'Failed to cache message');
      });
    }
  }

  cacheAndQueue(
    envelope: EnvelopeClass,
    plaintext: ArrayBuffer,
    request: IncomingWebSocketRequest
  ) {
    const { id } = envelope;
    const data = {
      id,
      version: 2,
      envelope: MessageReceiverInner.arrayBufferToStringBase64(plaintext),
      timestamp: envelope.receivedAtCounter,
      attempts: 1,
    };
    this.cacheAddBatcher.add({
      request,
      envelope,
      data,
    });
  }

  async cacheUpdateBatch(items: Array<Partial<UnprocessedType>>) {
    window.log.info('MessageReceiver.cacheUpdateBatch', items.length);
    await window.textsecure.storage.unprocessed.addDecryptedDataToList(items);
  }

  updateCache(envelope: EnvelopeClass, plaintext: ArrayBuffer) {
    const { id } = envelope;
    const data = {
      source: envelope.source,
      sourceUuid: envelope.sourceUuid,
      sourceDevice: envelope.sourceDevice,
      serverTimestamp: envelope.serverTimestamp,
      decrypted: MessageReceiverInner.arrayBufferToStringBase64(plaintext),
    };
    this.cacheUpdateBatcher.add({ id, data });
  }

  async cacheRemoveBatch(items: Array<string>) {
    await window.textsecure.storage.unprocessed.remove(items);
  }

  removeFromCache(envelope: EnvelopeClass) {
    const { id } = envelope;
    this.cacheRemoveBatcher.add(id);
  }

  async queueDecryptedEnvelope(
    envelope: EnvelopeClass,
    plaintext: ArrayBuffer
  ) {
    const id = this.getEnvelopeId(envelope);
    window.log.info('queueing decrypted envelope', id);

    const task = this.handleDecryptedEnvelope.bind(this, envelope, plaintext);
    const taskWithTimeout = window.textsecure.createTaskWithTimeout(
      task,
      `queueEncryptedEnvelope ${id}`
    );
    const promise = this.addToQueue(taskWithTimeout);

    return promise.catch(error => {
      window.log.error(
        `queueDecryptedEnvelope error handling envelope ${id}:`,
        error && error.extra ? JSON.stringify(error.extra) : '',
        error && error.stack ? error.stack : error
      );
    });
  }

  async queueEnvelope(envelope: EnvelopeClass) {
    const id = this.getEnvelopeId(envelope);
    window.log.info('queueing envelope', id);

    const task = this.handleEnvelope.bind(this, envelope);
    const taskWithTimeout = window.textsecure.createTaskWithTimeout(
      task,
      `queueEnvelope ${id}`
    );
    const promise = this.addToQueue(taskWithTimeout);

    return promise.catch(error => {
      const args = [
        'queueEnvelope error handling envelope',
        this.getEnvelopeId(envelope),
        ':',
        error && error.extra ? JSON.stringify(error.extra) : '',
        error && error.stack ? error.stack : error,
      ];
      if (error.warn) {
        window.log.warn(...args);
      } else {
        window.log.error(...args);
      }
    });
  }

  // Same as handleEnvelope, just without the decryption step. Necessary for handling
  //   messages which were successfully decrypted, but application logic didn't finish
  //   processing.
  async handleDecryptedEnvelope(
    envelope: EnvelopeClass,
    plaintext: ArrayBuffer
  ): Promise<void> {
    if (this.stoppingProcessing) {
      return;
    }
    // No decryption is required for delivery receipts, so the decrypted field of
    //   the Unprocessed model will never be set

    if (envelope.content) {
      await this.innerHandleContentMessage(envelope, plaintext);

      return;
    }
    if (envelope.legacyMessage) {
      await this.innerHandleLegacyMessage(envelope, plaintext);

      return;
    }

    this.removeFromCache(envelope);
    throw new Error('Received message with no content and no legacyMessage');
  }

  async handleEnvelope(envelope: EnvelopeClass) {
    if (this.stoppingProcessing) {
      return Promise.resolve();
    }

    if (envelope.type === window.textsecure.protobuf.Envelope.Type.RECEIPT) {
      return this.onDeliveryReceipt(envelope);
    }

    if (envelope.content) {
      return this.handleContentMessage(envelope);
    }
    if (envelope.legacyMessage) {
      return this.handleLegacyMessage(envelope);
    }
    this.removeFromCache(envelope);
    throw new Error('Received message with no content and no legacyMessage');
  }

  getStatus() {
    if (this.socket) {
      return this.socket.readyState;
    }
    if (this.hasConnected) {
      return WebSocket.CLOSED;
    }
    return -1;
  }

  async onDeliveryReceipt(envelope: EnvelopeClass) {
    return new Promise((resolve, reject) => {
      const ev = new Event('delivery');
      ev.confirm = this.removeFromCache.bind(this, envelope);
      ev.deliveryReceipt = {
        timestamp: envelope.timestamp.toNumber(),
        source: envelope.source,
        sourceUuid: envelope.sourceUuid,
        sourceDevice: envelope.sourceDevice,
      };
      this.dispatchAndWait(ev).then(resolve as any, reject as any);
    });
  }

  unpad(paddedData: ArrayBuffer) {
    const paddedPlaintext = new Uint8Array(paddedData);
    let plaintext;

    for (let i = paddedPlaintext.length - 1; i >= 0; i -= 1) {
      if (paddedPlaintext[i] === 0x80) {
        plaintext = new Uint8Array(i);
        plaintext.set(paddedPlaintext.subarray(0, i));
        plaintext = plaintext.buffer;
        break;
      } else if (paddedPlaintext[i] !== 0x00) {
        throw new Error('Invalid padding');
      }
    }

    return plaintext;
  }

  async decrypt(
    envelope: EnvelopeClass,
    ciphertext: any
  ): Promise<ArrayBuffer> {
    const { serverTrustRoot } = this;

    let promise;
    const identifier = envelope.sourceUuid || envelope.source;

    const address = new window.libsignal.SignalProtocolAddress(
      // Using source as opposed to sourceUuid allows us to get the existing
      // session if we haven't yet harvested the incoming uuid
      identifier as any,
      envelope.sourceDevice as any
    );

    const ourNumber = window.textsecure.storage.user.getNumber();
    const ourUuid = window.textsecure.storage.user.getUuid();
    const options: any = {};

    // No limit on message keys if we're communicating with our other devices
    if (
      (envelope.source && ourNumber && ourNumber === envelope.source) ||
      (envelope.sourceUuid && ourUuid && ourUuid === envelope.sourceUuid)
    ) {
      options.messageKeysLimit = false;
    }

    const sessionCipher = new window.libsignal.SessionCipher(
      window.textsecure.storage.protocol,
      address,
      options
    );
    const secretSessionCipher = new SecretSessionCipher(
      window.textsecure.storage.protocol,
      options
    );

    const me = {
      number: ourNumber,
      uuid: ourUuid,
      deviceId: parseInt(
        window.textsecure.storage.user.getDeviceId() as string,
        10
      ),
    };

    switch (envelope.type) {
      case window.textsecure.protobuf.Envelope.Type.CIPHERTEXT:
        window.log.info('message from', this.getEnvelopeId(envelope));
        promise = sessionCipher
          .decryptWhisperMessage(ciphertext)
          .then(this.unpad);
        break;
      case window.textsecure.protobuf.Envelope.Type.PREKEY_BUNDLE:
        window.log.info('prekey message from', this.getEnvelopeId(envelope));
        promise = this.decryptPreKeyWhisperMessage(
          ciphertext,
          sessionCipher,
          address
        );
        break;
      case window.textsecure.protobuf.Envelope.Type.UNIDENTIFIED_SENDER:
        window.log.info('received unidentified sender message');
        promise = secretSessionCipher
          .decrypt(
            createCertificateValidator(serverTrustRoot),
            ciphertext.toArrayBuffer(),
            Math.min(envelope.serverTimestamp || Date.now(), Date.now()),
            me
          )
          .then(
            result => {
              const { isMe, sender, senderUuid, content } = result;

              // We need to drop incoming messages from ourself since server can't
              //   do it for us
              if (isMe) {
                return { isMe: true };
              }

              if (
                (sender && this.isBlocked(sender.getName())) ||
                (senderUuid && this.isUuidBlocked(senderUuid.getName()))
              ) {
                window.log.info(
                  'Dropping blocked message after sealed sender decryption'
                );
                return { isBlocked: true };
              }

              // Here we take this sender information and attach it back to the envelope
              //   to make the rest of the app work properly.

              const originalSource = envelope.source;
              const originalSourceUuid = envelope.sourceUuid;

              // eslint-disable-next-line no-param-reassign
              envelope.source = sender && sender.getName();
              // eslint-disable-next-line no-param-reassign
              envelope.sourceUuid = senderUuid && senderUuid.getName();
              window.normalizeUuids(
                envelope,
                ['sourceUuid'],
                'message_receiver::decrypt::UNIDENTIFIED_SENDER'
              );
              // eslint-disable-next-line no-param-reassign
              envelope.sourceDevice =
                (sender && sender.getDeviceId()) ||
                (senderUuid && senderUuid.getDeviceId());
              // eslint-disable-next-line no-param-reassign
              envelope.unidentifiedDeliveryReceived = !(
                originalSource || originalSourceUuid
              );

              if (!content) {
                throw new Error(
                  'MessageReceiver.decrypt: Content returned was falsey!'
                );
              }

              // Return just the content because that matches the signature of the other
              //   decrypt methods used above.
              return this.unpad(content);
            },
            (error: Error) => {
              const { sender, senderUuid } = error || {};

              if (sender || senderUuid) {
                const originalSource = envelope.source;
                const originalSourceUuid = envelope.sourceUuid;

                if (
                  (sender && this.isBlocked(sender.getName())) ||
                  (senderUuid && this.isUuidBlocked(senderUuid.getName()))
                ) {
                  window.log.info(
                    'Dropping blocked message with error after sealed sender decryption'
                  );
                  return { isBlocked: true };
                }

                // eslint-disable-next-line no-param-reassign
                envelope.source = sender && sender.getName();
                // eslint-disable-next-line no-param-reassign
                envelope.sourceUuid =
                  senderUuid && senderUuid.getName().toLowerCase();
                window.normalizeUuids(
                  envelope,
                  ['sourceUuid'],
                  'message_receiver::decrypt::UNIDENTIFIED_SENDER::error'
                );
                // eslint-disable-next-line no-param-reassign
                envelope.sourceDevice =
                  (sender && sender.getDeviceId()) ||
                  (senderUuid && senderUuid.getDeviceId());
                // eslint-disable-next-line no-param-reassign
                envelope.unidentifiedDeliveryReceived = !(
                  originalSource || originalSourceUuid
                );

                throw error;
              }

              this.removeFromCache(envelope);
              throw error;
            }
          );
        break;
      default:
        promise = Promise.reject(new Error('Unknown message type'));
    }

    return promise
      .then((plaintext: any) => {
        const { isMe, isBlocked } = plaintext || {};
        if (isMe || isBlocked) {
          this.removeFromCache(envelope);
          return null;
        }

        // Note: this is an out of band update; there are cases where the item in the
        //   cache has already been deleted by the time this runs. That's okay.
        try {
          this.updateCache(envelope, plaintext);
        } catch (error) {
          const errorString = error && error.stack ? error.stack : error;
          window.log.error(`decrypt: updateCache failed: ${errorString}`);
        }

        return plaintext;
      })
      .catch(async error => {
        this.removeFromCache(envelope);

        const uuid = envelope.sourceUuid;
        const deviceId = envelope.sourceDevice;

        // We don't do a light session reset if it's just a duplicated message
        if (error && error.name === 'MessageCounterError') {
          throw error;
        }

        if (uuid && deviceId) {
          await this.maybeLightSessionReset(uuid, deviceId);
        } else {
          const envelopeId = this.getEnvelopeId(envelope);
          window.log.error(
            `MessageReceiver.decrypt: Envelope ${envelopeId} missing uuid or deviceId`
          );
        }

        throw error;
      });
  }

  isOverHourIntoPast(timestamp: number): boolean {
    const HOUR = 1000 * 60 * 60;
    const now = Date.now();
    const oneHourIntoPast = now - HOUR;

    return isNumber(timestamp) && timestamp <= oneHourIntoPast;
  }

  // We don't lose anything if we delete keys over an hour into the past, because we only
  //   change our behavior if the timestamps stored are less than an hour ago.
  cleanupSessionResets(): void {
    const sessionResets = window.storage.get(
      'sessionResets',
      {}
    ) as SessionResetsType;

    const keys = Object.keys(sessionResets);
    keys.forEach(key => {
      const timestamp = sessionResets[key];
      if (!timestamp || this.isOverHourIntoPast(timestamp)) {
        delete sessionResets[key];
      }
    });

    window.storage.put('sessionResets', sessionResets);
  }

  async maybeLightSessionReset(uuid: string, deviceId: number): Promise<void> {
    const id = `${uuid}.${deviceId}`;

    try {
      const sessionResets = window.storage.get(
        'sessionResets',
        {}
      ) as SessionResetsType;
      const lastReset = sessionResets[id];

      // We emit this event every time we encounter an error, not just when we reset the
      //   session. This is because a message might have been lost with every decryption
      //   failure.
      const event = new Event('light-session-reset');
      event.senderUuid = uuid;
      this.dispatchAndWait(event);

      if (lastReset && !this.isOverHourIntoPast(lastReset)) {
        window.log.warn(
          `maybeLightSessionReset/${id}: Skipping session reset, last reset at ${lastReset}`
        );
        return;
      }

      sessionResets[id] = Date.now();
      window.storage.put('sessionResets', sessionResets);

      await this.lightSessionReset(uuid, deviceId);
    } catch (error) {
      // If we failed to do the session reset, then we'll allow another attempt sooner
      //   than one hour from now.
      const sessionResets = window.storage.get(
        'sessionResets',
        {}
      ) as SessionResetsType;
      delete sessionResets[id];
      window.storage.put('sessionResets', sessionResets);

      const errorString = error && error.stack ? error.stack : error;
      window.log.error(
        `maybeLightSessionReset/${id}: Enountered error`,
        errorString
      );
    }
  }

  async lightSessionReset(uuid: string, deviceId: number): Promise<void> {
    const id = `${uuid}.${deviceId}`;

    // First, fetch this conversation
    const conversationId = window.ConversationController.ensureContactIds({
      uuid,
    });
    assert(conversationId, `lightSessionReset/${id}: missing conversationId`);

    const conversation = window.ConversationController.get(conversationId);
    assert(conversation, `lightSessionReset/${id}: missing conversation`);

    window.log.warn(`lightSessionReset/${id}: Resetting session`);

    // Archive open session with this device
    const address = new window.libsignal.SignalProtocolAddress(uuid, deviceId);
    const sessionCipher = new window.libsignal.SessionCipher(
      window.textsecure.storage.protocol,
      address
    );

    await sessionCipher.closeOpenSessionForDevice();

    // Send a null message with newly-created session
    const sendOptions = conversation.getSendOptions();
    await window.textsecure.messaging.sendNullMessage({ uuid }, sendOptions);
  }

  async decryptPreKeyWhisperMessage(
    ciphertext: ArrayBuffer,
    sessionCipher: SessionCipherClass,
    address: SignalProtocolAddressClass
  ) {
    const padded = await sessionCipher.decryptPreKeyWhisperMessage(ciphertext);

    try {
      return this.unpad(padded);
    } catch (e) {
      if (e.message === 'Unknown identity key') {
        // create an error that the UI will pick up and ask the
        // user if they want to re-negotiate
        const buffer = window.dcodeIO.ByteBuffer.wrap(ciphertext);
        throw new IncomingIdentityKeyError(
          address.toString(),
          buffer.toArrayBuffer(),
          e.identityKey
        );
      }
      throw e;
    }
  }

  async handleSentMessage(
    envelope: EnvelopeClass,
    sentContainer: SyncMessageClass.Sent
  ) {
    window.log.info(
      'MessageReceiver.handleSentMessage',
      this.getEnvelopeId(envelope)
    );
    const {
      destination,
      destinationUuid,
      timestamp,
      message: msg,
      expirationStartTimestamp,
      unidentifiedStatus,
      isRecipientUpdate,
    } = sentContainer;

    if (!msg) {
      throw new Error('MessageReceiver.handleSentMessage: message was falsey!');
    }

    let p: Promise<any> = Promise.resolve();
    // eslint-disable-next-line no-bitwise
    if (
      msg.flags &&
      msg.flags & window.textsecure.protobuf.DataMessage.Flags.END_SESSION
    ) {
      const identifier = destination || destinationUuid;
      if (!identifier) {
        throw new Error(
          'MessageReceiver.handleSentMessage: Cannot end session with falsey destination'
        );
      }
      p = this.handleEndSession(identifier);
    }
    return p.then(async () =>
      this.processDecrypted(envelope, msg).then(message => {
        // prettier-ignore
        const groupId = this.getGroupId(message);
        const isBlocked = this.isGroupBlocked(groupId);
        const { source, sourceUuid } = envelope;
        const ourE164 = window.textsecure.storage.user.getNumber();
        const ourUuid = window.textsecure.storage.user.getUuid();
        const isMe =
          (source && ourE164 && source === ourE164) ||
          (sourceUuid && ourUuid && sourceUuid === ourUuid);
        const isLeavingGroup = Boolean(
          !message.groupV2 &&
            message.group &&
            message.group.type ===
              window.textsecure.protobuf.GroupContext.Type.QUIT
        );

        if (groupId && isBlocked && !(isMe && isLeavingGroup)) {
          window.log.warn(
            `Message ${this.getEnvelopeId(
              envelope
            )} ignored; destined for blocked group`
          );
          this.removeFromCache(envelope);
          return undefined;
        }

        const ev = new Event('sent');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        ev.data = {
          destination,
          destinationUuid,
          timestamp: timestamp.toNumber(),
          serverTimestamp: envelope.serverTimestamp,
          device: envelope.sourceDevice,
          unidentifiedStatus,
          message,
          isRecipientUpdate,
          receivedAtCounter: envelope.receivedAtCounter,
          receivedAtDate: envelope.receivedAtDate,
        };
        if (expirationStartTimestamp) {
          ev.data.expirationStartTimestamp = expirationStartTimestamp.toNumber();
        }
        return this.dispatchAndWait(ev);
      })
    );
  }

  async handleDataMessage(envelope: EnvelopeClass, msg: DataMessageClass) {
    window.log.info(
      'MessageReceiver.handleDataMessage',
      this.getEnvelopeId(envelope)
    );
    let p: Promise<any> = Promise.resolve();
    // eslint-disable-next-line no-bitwise
    const destination = envelope.sourceUuid || envelope.source;
    if (!destination) {
      throw new Error(
        'MessageReceiver.handleDataMessage: source and sourceUuid were falsey'
      );
    }

    if (this.isInvalidGroupData(msg, envelope)) {
      this.removeFromCache(envelope);
      return undefined;
    }

    await this.deriveGroupV1Data(msg);
    this.deriveGroupV2Data(msg);

    if (
      msg.flags &&
      msg.flags & window.textsecure.protobuf.DataMessage.Flags.END_SESSION
    ) {
      p = this.handleEndSession(destination);
    }

    if (
      msg.flags &&
      msg.flags &
        window.textsecure.protobuf.DataMessage.Flags.PROFILE_KEY_UPDATE
    ) {
      const ev = new Event('profileKeyUpdate');
      ev.confirm = this.removeFromCache.bind(this, envelope);
      ev.data = {
        source: envelope.source,
        sourceUuid: envelope.sourceUuid,
        profileKey: msg.profileKey.toString('base64'),
      };
      return this.dispatchAndWait(ev);
    }

    return p.then(async () =>
      this.processDecrypted(envelope, msg).then(message => {
        // prettier-ignore
        const groupId = this.getGroupId(message);
        const isBlocked = this.isGroupBlocked(groupId);
        const { source, sourceUuid } = envelope;
        const ourE164 = window.textsecure.storage.user.getNumber();
        const ourUuid = window.textsecure.storage.user.getUuid();
        const isMe =
          (source && ourE164 && source === ourE164) ||
          (sourceUuid && ourUuid && sourceUuid === ourUuid);
        const isLeavingGroup = Boolean(
          !message.groupV2 &&
            message.group &&
            message.group.type ===
              window.textsecure.protobuf.GroupContext.Type.QUIT
        );

        if (groupId && isBlocked && !(isMe && isLeavingGroup)) {
          window.log.warn(
            `Message ${this.getEnvelopeId(
              envelope
            )} ignored; destined for blocked group`
          );
          this.removeFromCache(envelope);
          return undefined;
        }

        const ev = new Event('message');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        ev.data = {
          source: envelope.source,
          sourceUuid: envelope.sourceUuid,
          sourceDevice: envelope.sourceDevice,
          timestamp: envelope.timestamp.toNumber(),
          serverTimestamp: envelope.serverTimestamp,
          unidentifiedDeliveryReceived: envelope.unidentifiedDeliveryReceived,
          message,
          receivedAtCounter: envelope.receivedAtCounter,
          receivedAtDate: envelope.receivedAtDate,
        };
        return this.dispatchAndWait(ev);
      })
    );
  }

  async handleLegacyMessage(envelope: EnvelopeClass) {
    window.log.info(
      'MessageReceiver.handleLegacyMessage',
      this.getEnvelopeId(envelope)
    );
    return this.decrypt(envelope, envelope.legacyMessage).then(plaintext => {
      if (!plaintext) {
        window.log.warn('handleLegacyMessage: plaintext was falsey');
        return null;
      }
      return this.innerHandleLegacyMessage(envelope, plaintext);
    });
  }

  async innerHandleLegacyMessage(
    envelope: EnvelopeClass,
    plaintext: ArrayBuffer
  ) {
    const message = window.textsecure.protobuf.DataMessage.decode(plaintext);
    return this.handleDataMessage(envelope, message);
  }

  async handleContentMessage(envelope: EnvelopeClass) {
    window.log.info(
      'MessageReceiver.handleContentMessage',
      this.getEnvelopeId(envelope)
    );
    return this.decrypt(envelope, envelope.content).then(plaintext => {
      if (!plaintext) {
        window.log.warn('handleContentMessage: plaintext was falsey');
        return null;
      }
      return this.innerHandleContentMessage(envelope, plaintext);
    });
  }

  async innerHandleContentMessage(
    envelope: EnvelopeClass,
    plaintext: ArrayBuffer
  ) {
    const content = window.textsecure.protobuf.Content.decode(plaintext);
    if (content.syncMessage) {
      return this.handleSyncMessage(envelope, content.syncMessage);
    }
    if (content.dataMessage) {
      return this.handleDataMessage(envelope, content.dataMessage);
    }
    if (content.nullMessage) {
      this.handleNullMessage(envelope);
      return undefined;
    }
    if (content.callingMessage) {
      return this.handleCallingMessage(envelope, content.callingMessage);
    }
    if (content.receiptMessage) {
      return this.handleReceiptMessage(envelope, content.receiptMessage);
    }
    if (content.typingMessage) {
      return this.handleTypingMessage(envelope, content.typingMessage);
    }
    this.removeFromCache(envelope);
    throw new Error('Unsupported content message');
  }

  async handleCallingMessage(
    envelope: EnvelopeClass,
    callingMessage: CallingMessageClass
  ) {
    this.removeFromCache(envelope);
    await window.Signal.Services.calling.handleCallingMessage(
      envelope,
      callingMessage
    );
  }

  async handleReceiptMessage(
    envelope: EnvelopeClass,
    receiptMessage: ReceiptMessageClass
  ) {
    const results = [];
    if (
      receiptMessage.type ===
      window.textsecure.protobuf.ReceiptMessage.Type.DELIVERY
    ) {
      for (let i = 0; i < receiptMessage.timestamp.length; i += 1) {
        const ev = new Event('delivery');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        ev.deliveryReceipt = {
          timestamp: receiptMessage.timestamp[i].toNumber(),
          envelopeTimestamp: envelope.timestamp.toNumber(),
          source: envelope.source,
          sourceUuid: envelope.sourceUuid,
          sourceDevice: envelope.sourceDevice,
        };
        results.push(this.dispatchAndWait(ev));
      }
    } else if (
      receiptMessage.type ===
      window.textsecure.protobuf.ReceiptMessage.Type.READ
    ) {
      for (let i = 0; i < receiptMessage.timestamp.length; i += 1) {
        const ev = new Event('read');
        ev.confirm = this.removeFromCache.bind(this, envelope);
        ev.timestamp = envelope.timestamp.toNumber();
        ev.read = {
          timestamp: receiptMessage.timestamp[i].toNumber(),
          envelopeTimestamp: envelope.timestamp.toNumber(),
          source: envelope.source,
          sourceUuid: envelope.sourceUuid,
        };
        results.push(this.dispatchAndWait(ev));
      }
    }
    return Promise.all(results);
  }

  async handleTypingMessage(
    envelope: EnvelopeClass,
    typingMessage: TypingMessageClass
  ) {
    const ev = new Event('typing');

    this.removeFromCache(envelope);

    if (envelope.timestamp && typingMessage.timestamp) {
      const envelopeTimestamp = envelope.timestamp.toNumber();
      const typingTimestamp = typingMessage.timestamp.toNumber();

      if (typingTimestamp !== envelopeTimestamp) {
        window.log.warn(
          `Typing message envelope timestamp (${envelopeTimestamp}) did not match typing timestamp (${typingTimestamp})`
        );
        return null;
      }
    }

    const { groupId, timestamp, action } = typingMessage;

    ev.sender = envelope.source;
    ev.senderUuid = envelope.sourceUuid;
    ev.senderDevice = envelope.sourceDevice;

    ev.typing = {
      typingMessage,
      timestamp: timestamp ? timestamp.toNumber() : Date.now(),
      started:
        action === window.textsecure.protobuf.TypingMessage.Action.STARTED,
      stopped:
        action === window.textsecure.protobuf.TypingMessage.Action.STOPPED,
    };

    const groupIdBuffer = groupId ? groupId.toArrayBuffer() : null;

    if (groupIdBuffer && groupIdBuffer.byteLength > 0) {
      if (groupIdBuffer.byteLength === GROUPV1_ID_LENGTH) {
        ev.typing.groupId = groupId.toString('binary');
        ev.typing.groupV2Id = await this.deriveGroupV2FromV1(groupIdBuffer);
      } else if (groupIdBuffer.byteLength === GROUPV2_ID_LENGTH) {
        ev.typing.groupV2Id = groupId.toString('base64');
      } else {
        window.log.error('handleTypingMessage: Received invalid groupId value');
        this.removeFromCache(envelope);
      }
    }

    return this.dispatchEvent(ev);
  }

  handleNullMessage(envelope: EnvelopeClass) {
    window.log.info(
      'MessageReceiver.handleNullMessage',
      this.getEnvelopeId(envelope)
    );
    this.removeFromCache(envelope);
  }

  isInvalidGroupData(
    message: DataMessageClass,
    envelope: EnvelopeClass
  ): boolean {
    const { group, groupV2 } = message;

    if (group) {
      const id = group.id.toArrayBuffer();
      const isInvalid = id.byteLength !== GROUPV1_ID_LENGTH;

      if (isInvalid) {
        window.log.info(
          'isInvalidGroupData: invalid GroupV1 message from',
          this.getEnvelopeId(envelope)
        );
      }

      return isInvalid;
    }

    if (groupV2) {
      const masterKey = groupV2.masterKey.toArrayBuffer();
      const isInvalid = masterKey.byteLength !== MASTER_KEY_LENGTH;

      if (isInvalid) {
        window.log.info(
          'isInvalidGroupData: invalid GroupV2 message from',
          this.getEnvelopeId(envelope)
        );
      }
      return isInvalid;
    }

    return false;
  }

  async deriveGroupV2FromV1(groupId: ArrayBuffer): Promise<string> {
    if (groupId.byteLength !== GROUPV1_ID_LENGTH) {
      throw new Error(
        `deriveGroupV2FromV1: had id with wrong byteLength: ${groupId.byteLength}`
      );
    }
    const masterKey = await deriveMasterKeyFromGroupV1(groupId);
    const data = deriveGroupFields(masterKey);

    const toBase64 = MessageReceiverInner.arrayBufferToStringBase64;
    return toBase64(data.id);
  }

  async deriveGroupV1Data(message: DataMessageClass) {
    const { group } = message;

    if (!group) {
      return;
    }

    if (!group.id) {
      throw new Error('deriveGroupV1Data: had falsey id');
    }

    const id = group.id.toArrayBuffer();
    if (id.byteLength !== GROUPV1_ID_LENGTH) {
      throw new Error(
        `deriveGroupV1Data: had id with wrong byteLength: ${id.byteLength}`
      );
    }
    group.derivedGroupV2Id = await this.deriveGroupV2FromV1(id);
  }

  deriveGroupV2Data(message: DataMessageClass) {
    const { groupV2 } = message;

    if (!groupV2) {
      return;
    }

    if (!isNumber(groupV2.revision)) {
      throw new Error('deriveGroupV2Data: revision was not a number');
    }
    if (!groupV2.masterKey) {
      throw new Error('deriveGroupV2Data: had falsey masterKey');
    }

    const toBase64 = MessageReceiverInner.arrayBufferToStringBase64;
    const masterKey: ArrayBuffer = groupV2.masterKey.toArrayBuffer();
    const length = masterKey.byteLength;
    if (length !== MASTER_KEY_LENGTH) {
      throw new Error(
        `deriveGroupV2Data: masterKey had length ${length}, expected ${MASTER_KEY_LENGTH}`
      );
    }

    const fields = deriveGroupFields(masterKey);
    groupV2.masterKey = toBase64(masterKey);
    groupV2.secretParams = toBase64(fields.secretParams);
    groupV2.publicParams = toBase64(fields.publicParams);
    groupV2.id = toBase64(fields.id);

    if (groupV2.groupChange) {
      groupV2.groupChange = groupV2.groupChange.toString('base64');
    }
  }

  getGroupId(message: DataMessageClass) {
    if (message.groupV2) {
      return message.groupV2.id;
    }
    if (message.group) {
      return message.group.id.toString('binary');
    }

    return null;
  }

  getDestination(sentMessage: SyncMessageClass.Sent) {
    if (sentMessage.message && sentMessage.message.groupV2) {
      return `groupv2(${sentMessage.message.groupV2.id})`;
    }
    if (sentMessage.message && sentMessage.message.group) {
      return `group(${sentMessage.message.group.id.toBinary()})`;
    }
    return sentMessage.destination || sentMessage.destinationUuid;
  }

  async handleSyncMessage(
    envelope: EnvelopeClass,
    syncMessage: SyncMessageClass
  ) {
    const unidentified = syncMessage.sent
      ? syncMessage.sent.unidentifiedStatus || []
      : [];
    window.normalizeUuids(
      syncMessage,
      [
        'sent.destinationUuid',
        ...unidentified.map(
          (_el, i) => `sent.unidentifiedStatus.${i}.destinationUuid`
        ),
      ],
      'message_receiver::handleSyncMessage'
    );
    const fromSelfSource =
      envelope.source && envelope.source === this.number_id;
    const fromSelfSourceUuid =
      envelope.sourceUuid && envelope.sourceUuid === this.uuid_id;
    if (!fromSelfSource && !fromSelfSourceUuid) {
      throw new Error('Received sync message from another number');
    }
    // eslint-disable-next-line eqeqeq
    if (envelope.sourceDevice == this.deviceId) {
      throw new Error('Received sync message from our own device');
    }
    if (syncMessage.sent) {
      const sentMessage = syncMessage.sent;

      if (!sentMessage || !sentMessage.message) {
        throw new Error(
          'MessageReceiver.handleSyncMessage: sync sent message was missing message'
        );
      }

      if (this.isInvalidGroupData(sentMessage.message, envelope)) {
        this.removeFromCache(envelope);
        return undefined;
      }

      await this.deriveGroupV1Data(sentMessage.message);
      this.deriveGroupV2Data(sentMessage.message);

      window.log.info(
        'sent message to',
        this.getDestination(sentMessage),
        sentMessage.timestamp.toNumber(),
        'from',
        this.getEnvelopeId(envelope)
      );
      return this.handleSentMessage(envelope, sentMessage);
    }
    if (syncMessage.contacts) {
      this.handleContacts(envelope, syncMessage.contacts);
      return undefined;
    }
    if (syncMessage.groups) {
      this.handleGroups(envelope, syncMessage.groups);
      return undefined;
    }
    if (syncMessage.blocked) {
      return this.handleBlocked(envelope, syncMessage.blocked);
    }
    if (syncMessage.request) {
      window.log.info('Got SyncMessage Request');
      this.removeFromCache(envelope);
      return undefined;
    }
    if (syncMessage.read && syncMessage.read.length) {
      return this.handleRead(envelope, syncMessage.read);
    }
    if (syncMessage.verified) {
      return this.handleVerified(envelope, syncMessage.verified);
    }
    if (syncMessage.configuration) {
      return this.handleConfiguration(envelope, syncMessage.configuration);
    }
    if (
      syncMessage.stickerPackOperation &&
      syncMessage.stickerPackOperation.length > 0
    ) {
      return this.handleStickerPackOperation(
        envelope,
        syncMessage.stickerPackOperation
      );
    }
    if (syncMessage.viewOnceOpen) {
      return this.handleViewOnceOpen(envelope, syncMessage.viewOnceOpen);
    }
    if (syncMessage.messageRequestResponse) {
      return this.handleMessageRequestResponse(
        envelope,
        syncMessage.messageRequestResponse
      );
    }
    if (syncMessage.fetchLatest) {
      return this.handleFetchLatest(envelope, syncMessage.fetchLatest);
    }
    if (syncMessage.keys) {
      return this.handleKeys(envelope, syncMessage.keys);
    }

    this.removeFromCache(envelope);
    throw new Error('Got empty SyncMessage');
  }

  async handleConfiguration(
    envelope: EnvelopeClass,
    configuration: SyncMessageClass.Configuration
  ) {
    window.log.info('got configuration sync message');
    const ev = new Event('configuration');
    ev.confirm = this.removeFromCache.bind(this, envelope);
    ev.configuration = configuration;
    return this.dispatchAndWait(ev);
  }

  async handleViewOnceOpen(
    envelope: EnvelopeClass,
    sync: SyncMessageClass.ViewOnceOpen
  ) {
    window.log.info('got view once open sync message');

    const ev = new Event('viewSync');
    ev.confirm = this.removeFromCache.bind(this, envelope);
    ev.source = sync.sender;
    ev.sourceUuid = sync.senderUuid;
    ev.timestamp = sync.timestamp ? sync.timestamp.toNumber() : null;

    window.normalizeUuids(
      ev,
      ['sourceUuid'],
      'message_receiver::handleViewOnceOpen'
    );

    return this.dispatchAndWait(ev);
  }

  async handleMessageRequestResponse(
    envelope: EnvelopeClass,
    sync: SyncMessageClass.MessageRequestResponse
  ) {
    window.log.info('got message request response sync message');

    const ev = new Event('messageRequestResponse');
    ev.confirm = this.removeFromCache.bind(this, envelope);
    ev.threadE164 = sync.threadE164;
    ev.threadUuid = sync.threadUuid;
    ev.messageRequestResponseType = sync.type;

    const idBuffer: ArrayBuffer = sync.groupId
      ? sync.groupId.toArrayBuffer()
      : null;

    if (idBuffer && idBuffer.byteLength > 0) {
      if (idBuffer.byteLength === GROUPV1_ID_LENGTH) {
        ev.groupId = sync.groupId.toString('binary');
        ev.groupV2Id = await this.deriveGroupV2FromV1(idBuffer);
      } else if (idBuffer.byteLength === GROUPV2_ID_LENGTH) {
        ev.groupV2Id = sync.groupId.toString('base64');
      } else {
        this.removeFromCache(envelope);
        window.log.error('Received message request with invalid groupId');
        return undefined;
      }
    }

    window.normalizeUuids(
      ev,
      ['threadUuid'],
      'MessageReceiver::handleMessageRequestResponse'
    );

    return this.dispatchAndWait(ev);
  }

  async handleFetchLatest(
    envelope: EnvelopeClass,
    sync: SyncMessageClass.FetchLatest
  ) {
    window.log.info('got fetch latest sync message');

    const ev = new Event('fetchLatest');
    ev.confirm = this.removeFromCache.bind(this, envelope);
    ev.eventType = sync.type;

    return this.dispatchAndWait(ev);
  }

  async handleKeys(envelope: EnvelopeClass, sync: SyncMessageClass.Keys) {
    window.log.info('got keys sync message');

    if (!sync.storageService) {
      return undefined;
    }

    const ev = new Event('keys');
    ev.confirm = this.removeFromCache.bind(this, envelope);
    ev.storageServiceKey = sync.storageService.toArrayBuffer();

    return this.dispatchAndWait(ev);
  }

  async handleStickerPackOperation(
    envelope: EnvelopeClass,
    operations: Array<SyncMessageClass.StickerPackOperation>
  ) {
    const ENUM =
      window.textsecure.protobuf.SyncMessage.StickerPackOperation.Type;
    window.log.info('got sticker pack operation sync message');
    const ev = new Event('sticker-pack');
    ev.confirm = this.removeFromCache.bind(this, envelope);
    ev.stickerPacks = operations.map(operation => ({
      id: operation.packId ? operation.packId.toString('hex') : null,
      key: operation.packKey ? operation.packKey.toString('base64') : null,
      isInstall: operation.type === ENUM.INSTALL,
      isRemove: operation.type === ENUM.REMOVE,
    }));
    return this.dispatchAndWait(ev);
  }

  async handleVerified(envelope: EnvelopeClass, verified: VerifiedClass) {
    const ev = new Event('verified');
    ev.confirm = this.removeFromCache.bind(this, envelope);
    ev.verified = {
      state: verified.state,
      destination: verified.destination,
      destinationUuid: verified.destinationUuid,
      identityKey: verified.identityKey.toArrayBuffer(),
    };
    window.normalizeUuids(
      ev,
      ['verified.destinationUuid'],
      'message_receiver::handleVerified'
    );
    return this.dispatchAndWait(ev);
  }

  async handleRead(
    envelope: EnvelopeClass,
    read: Array<SyncMessageClass.Read>
  ) {
    window.log.info('MessageReceiver.handleRead', this.getEnvelopeId(envelope));
    const results = [];
    for (let i = 0; i < read.length; i += 1) {
      const ev = new Event('readSync');
      ev.confirm = this.removeFromCache.bind(this, envelope);
      ev.timestamp = envelope.timestamp.toNumber();
      ev.read = {
        envelopeTimestamp: envelope.timestamp.toNumber(),
        timestamp: read[i].timestamp.toNumber(),
        sender: read[i].sender,
        senderUuid: read[i].senderUuid,
      };
      window.normalizeUuids(
        ev,
        ['read.senderUuid'],
        'message_receiver::handleRead'
      );
      results.push(this.dispatchAndWait(ev));
    }
    return Promise.all(results);
  }

  handleContacts(envelope: EnvelopeClass, contacts: SyncMessageClass.Contacts) {
    window.log.info('contact sync');
    const { blob } = contacts;
    if (!blob) {
      throw new Error('MessageReceiver.handleContacts: blob field was missing');
    }

    this.removeFromCache(envelope);

    // Note: we do not return here because we don't want to block the next message on
    //   this attachment download and a lot of processing of that attachment.
    this.handleAttachment(blob).then(async attachmentPointer => {
      const results = [];
      const contactBuffer = new ContactBuffer(attachmentPointer.data);
      let contactDetails = contactBuffer.next();
      while (contactDetails !== undefined) {
        const contactEvent = new Event('contact');
        contactEvent.contactDetails = contactDetails;
        window.normalizeUuids(
          contactEvent,
          ['contactDetails.verified.destinationUuid'],
          'message_receiver::handleContacts::handleAttachment'
        );
        results.push(this.dispatchAndWait(contactEvent));

        contactDetails = contactBuffer.next();
      }

      const finalEvent = new Event('contactsync');
      results.push(this.dispatchAndWait(finalEvent));

      return Promise.all(results).then(() => {
        window.log.info('handleContacts: finished');
      });
    });
  }

  handleGroups(envelope: EnvelopeClass, groups: SyncMessageClass.Groups) {
    window.log.info('group sync');
    const { blob } = groups;

    this.removeFromCache(envelope);

    if (!blob) {
      throw new Error('MessageReceiver.handleGroups: blob field was missing');
    }

    // Note: we do not return here because we don't want to block the next message on
    //   this attachment download and a lot of processing of that attachment.
    this.handleAttachment(blob).then(async attachmentPointer => {
      const groupBuffer = new GroupBuffer(attachmentPointer.data);
      let groupDetails = groupBuffer.next() as any;
      const promises = [];
      while (groupDetails) {
        groupDetails.id = groupDetails.id.toBinary();
        const ev = new Event('group');
        ev.groupDetails = groupDetails;
        const promise = this.dispatchAndWait(ev).catch(e => {
          window.log.error('error processing group', e);
        });
        groupDetails = groupBuffer.next();
        promises.push(promise);
      }

      return Promise.all(promises).then(async () => {
        const ev = new Event('groupsync');
        return this.dispatchAndWait(ev);
      });
    });
  }

  async handleBlocked(
    envelope: EnvelopeClass,
    blocked: SyncMessageClass.Blocked
  ) {
    window.log.info('Setting these numbers as blocked:', blocked.numbers);
    await window.textsecure.storage.put('blocked', blocked.numbers);
    if (blocked.uuids) {
      window.normalizeUuids(
        blocked,
        blocked.uuids.map((_uuid: string, i: number) => `uuids.${i}`),
        'message_receiver::handleBlocked'
      );
      window.log.info('Setting these uuids as blocked:', blocked.uuids);
      await window.textsecure.storage.put('blocked-uuids', blocked.uuids);
    }

    const groupIds = map(blocked.groupIds, groupId => groupId.toBinary());
    window.log.info(
      'Setting these groups as blocked:',
      groupIds.map(groupId => `group(${groupId})`)
    );
    await window.textsecure.storage.put('blocked-groups', groupIds);

    this.removeFromCache(envelope);
  }

  isBlocked(number: string) {
    return window.textsecure.storage.get('blocked', []).includes(number);
  }

  isUuidBlocked(uuid: string) {
    return window.textsecure.storage.get('blocked-uuids', []).includes(uuid);
  }

  isGroupBlocked(groupId: string) {
    return window.textsecure.storage
      .get('blocked-groups', [])
      .includes(groupId);
  }

  cleanAttachment(attachment: AttachmentPointerClass) {
    return {
      ...omit(attachment, 'thumbnail'),
      cdnId: attachment.cdnId?.toString(),
      key: attachment.key ? attachment.key.toString('base64') : null,
      digest: attachment.digest ? attachment.digest.toString('base64') : null,
    };
  }

  private isLinkPreviewDateValid(value: unknown): value is number {
    return (
      typeof value === 'number' &&
      !Number.isNaN(value) &&
      Number.isFinite(value) &&
      value > 0
    );
  }

  private cleanLinkPreviewDate(value: unknown): number | null {
    if (this.isLinkPreviewDateValid(value)) {
      return value;
    }
    if (!value) {
      return null;
    }
    let result: unknown;
    try {
      result = (value as any).toNumber();
    } catch (err) {
      return null;
    }
    return this.isLinkPreviewDateValid(result) ? result : null;
  }

  async downloadAttachment(
    attachment: AttachmentPointerClass
  ): Promise<DownloadAttachmentType> {
    const encrypted = await this.server.getAttachment(
      attachment.cdnId || attachment.cdnKey,
      attachment.cdnNumber || 0
    );
    const { key, digest, size } = attachment;

    if (!digest) {
      throw new Error('Failure: Ask sender to update Signal and resend.');
    }

    const paddedData = await Crypto.decryptAttachment(
      encrypted,
      MessageReceiverInner.stringToArrayBufferBase64(key),
      MessageReceiverInner.stringToArrayBufferBase64(digest)
    );

    if (!isNumber(size)) {
      throw new Error(
        `downloadAttachment: Size was not provided, actual size was ${paddedData.byteLength}`
      );
    }

    const data = window.Signal.Crypto.getFirstBytes(paddedData, size);

    return {
      ...omit(attachment, 'digest', 'key'),
      data,
    };
  }

  async handleAttachment(
    attachment: AttachmentPointerClass
  ): Promise<DownloadAttachmentType> {
    const cleaned = this.cleanAttachment(attachment);
    return this.downloadAttachment(cleaned);
  }

  async handleEndSession(identifier: string) {
    window.log.info('got end session');
    const deviceIds = await window.textsecure.storage.protocol.getDeviceIds(
      identifier
    );

    return Promise.all(
      deviceIds.map(async deviceId => {
        const address = new window.libsignal.SignalProtocolAddress(
          identifier,
          deviceId
        );
        const sessionCipher = new window.libsignal.SessionCipher(
          window.textsecure.storage.protocol,
          address
        );

        window.log.info(
          'handleEndSession: closing sessions for',
          address.toString()
        );
        return sessionCipher.closeOpenSessionForDevice();
      })
    );
  }

  async processDecrypted(envelope: EnvelopeClass, decrypted: DataMessageClass) {
    /* eslint-disable no-bitwise, no-param-reassign */
    const FLAGS = window.textsecure.protobuf.DataMessage.Flags;

    // Now that its decrypted, validate the message and clean it up for consumer
    //   processing
    // Note that messages may (generally) only perform one action and we ignore remaining
    //   fields after the first action.

    if (!envelope.timestamp || !decrypted.timestamp) {
      throw new Error('Missing timestamp on dataMessage or envelope');
    }

    const envelopeTimestamp = envelope.timestamp.toNumber();
    const decryptedTimestamp = decrypted.timestamp.toNumber();

    if (envelopeTimestamp !== decryptedTimestamp) {
      throw new Error(
        `Timestamp ${decrypted.timestamp} in DataMessage did not match envelope timestamp ${envelope.timestamp}`
      );
    }

    if (decrypted.flags == null) {
      decrypted.flags = 0;
    }
    if (decrypted.expireTimer == null) {
      decrypted.expireTimer = 0;
    }

    if (decrypted.flags & FLAGS.END_SESSION) {
      decrypted.body = null;
      decrypted.attachments = [];
      decrypted.group = null;
      return Promise.resolve(decrypted);
    }
    if (decrypted.flags & FLAGS.EXPIRATION_TIMER_UPDATE) {
      decrypted.body = null;
      decrypted.attachments = [];
    } else if (decrypted.flags & FLAGS.PROFILE_KEY_UPDATE) {
      decrypted.body = null;
      decrypted.attachments = [];
    } else if (decrypted.flags !== 0) {
      throw new Error('Unknown flags in message');
    }

    if (decrypted.group) {
      decrypted.group.id = decrypted.group.id.toBinary();

      switch (decrypted.group.type) {
        case window.textsecure.protobuf.GroupContext.Type.UPDATE:
          decrypted.body = null;
          decrypted.attachments = [];
          break;
        case window.textsecure.protobuf.GroupContext.Type.QUIT:
          decrypted.body = null;
          decrypted.attachments = [];
          break;
        case window.textsecure.protobuf.GroupContext.Type.DELIVER:
          decrypted.group.name = null;
          decrypted.group.membersE164 = [];
          decrypted.group.avatar = null;
          break;
        default: {
          this.removeFromCache(envelope);
          const err = new Error('Unknown group message type');
          err.warn = true;
          throw err;
        }
      }
    }

    const attachmentCount = (decrypted.attachments || []).length;
    const ATTACHMENT_MAX = 32;
    if (attachmentCount > ATTACHMENT_MAX) {
      throw new Error(
        `Too many attachments: ${attachmentCount} included in one message, max is ${ATTACHMENT_MAX}`
      );
    }

    // Here we go from binary to string/base64 in all AttachmentPointer digest/key fields

    if (
      decrypted.group &&
      decrypted.group.type ===
        window.textsecure.protobuf.GroupContext.Type.UPDATE
    ) {
      if (decrypted.group.avatar) {
        decrypted.group.avatar = this.cleanAttachment(decrypted.group.avatar);
      }
    }

    decrypted.attachments = (decrypted.attachments || []).map(
      this.cleanAttachment.bind(this)
    );
    decrypted.preview = (decrypted.preview || []).map(item => ({
      ...item,
      date: this.cleanLinkPreviewDate(item.date),
      ...(item.image ? { image: this.cleanAttachment(item.image) } : {}),
    }));
    decrypted.contact = (decrypted.contact || []).map(item => {
      const { avatar } = item;

      if (!avatar || !avatar.avatar) {
        return item;
      }

      return {
        ...item,
        avatar: {
          ...item.avatar,
          avatar: this.cleanAttachment(item.avatar.avatar),
        },
      };
    });

    if (decrypted.quote && decrypted.quote.id) {
      decrypted.quote.id = decrypted.quote.id.toNumber();
    }

    if (decrypted.quote) {
      decrypted.quote.attachments = (decrypted.quote.attachments || []).map(
        item => {
          if (!item.thumbnail) {
            return item;
          }

          return {
            ...item,
            thumbnail: this.cleanAttachment(item.thumbnail),
          };
        }
      );
    }

    const { sticker } = decrypted;
    if (sticker) {
      if (sticker.packId) {
        sticker.packId = sticker.packId.toString('hex');
      }
      if (sticker.packKey) {
        sticker.packKey = sticker.packKey.toString('base64');
      }
      if (sticker.data) {
        sticker.data = this.cleanAttachment(sticker.data);
      }
    }

    const { delete: del } = decrypted;
    if (del) {
      if (del.targetSentTimestamp) {
        del.targetSentTimestamp = del.targetSentTimestamp.toNumber();
      }
    }

    const { reaction } = decrypted;
    if (reaction) {
      if (reaction.targetTimestamp) {
        reaction.targetTimestamp = reaction.targetTimestamp.toNumber();
      }
    }

    return Promise.resolve(decrypted);
    /* eslint-enable no-bitwise, no-param-reassign */
  }
}

export default class MessageReceiver {
  constructor(
    oldUsername: string,
    username: string,
    password: string,
    signalingKey: ArrayBuffer,
    options: {
      serverTrustRoot: string;
      retryCached?: string;
    }
  ) {
    const inner = new MessageReceiverInner(
      oldUsername,
      username,
      password,
      signalingKey,
      options
    );

    this.addEventListener = inner.addEventListener.bind(inner);
    this.close = inner.close.bind(inner);
    this.downloadAttachment = inner.downloadAttachment.bind(inner);
    this.getStatus = inner.getStatus.bind(inner);
    this.hasEmptied = inner.hasEmptied.bind(inner);
    this.removeEventListener = inner.removeEventListener.bind(inner);
    this.stopProcessing = inner.stopProcessing.bind(inner);
    this.unregisterBatchers = inner.unregisterBatchers.bind(inner);

    // For tests
    this.isOverHourIntoPast = inner.isOverHourIntoPast.bind(inner);
    this.cleanupSessionResets = inner.cleanupSessionResets.bind(inner);

    inner.connect();
    this.getProcessedCount = () => inner.processedCount;
  }

  addEventListener: (name: string, handler: Function) => void;

  close: () => Promise<void>;

  downloadAttachment: (
    attachment: AttachmentPointerClass
  ) => Promise<DownloadAttachmentType>;

  getStatus: () => number;

  hasEmptied: () => boolean;

  removeEventListener: (name: string, handler: Function) => void;

  stopProcessing: () => Promise<void>;

  unregisterBatchers: () => void;

  isOverHourIntoPast: (timestamp: number) => boolean;

  cleanupSessionResets: () => void;

  getProcessedCount: () => number;

  static stringToArrayBuffer = MessageReceiverInner.stringToArrayBuffer;

  static arrayBufferToString = MessageReceiverInner.arrayBufferToString;

  static stringToArrayBufferBase64 =
    MessageReceiverInner.stringToArrayBufferBase64;

  static arrayBufferToStringBase64 =
    MessageReceiverInner.arrayBufferToStringBase64;
}
