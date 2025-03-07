// Copyright 2019-2020 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { pick } from 'lodash';
import React from 'react';
import { connect } from 'react-redux';
import { mapDispatchToProps } from '../actions';
import { GlobalAudioContext } from '../../components/GlobalAudioContext';
import { Timeline } from '../../components/conversation/Timeline';
import { RenderEmojiPickerProps } from '../../components/conversation/ReactionPicker';
import { StateType } from '../reducer';

import { getIntl } from '../selectors/user';
import {
  getConversationMessagesSelector,
  getConversationSelector,
  getInvitedContactsForNewlyCreatedGroup,
  getSelectedMessage,
} from '../selectors/conversations';

import { SmartTimelineItem } from './TimelineItem';
import { SmartTypingBubble } from './TypingBubble';
import { SmartLastSeenIndicator } from './LastSeenIndicator';
import { SmartHeroRow } from './HeroRow';
import { SmartTimelineLoadingRow } from './TimelineLoadingRow';
import { SmartEmojiPicker } from './EmojiPicker';
import { SmartMessageAudio, Props as MessageAudioProps } from './MessageAudio';

// Workaround: A react component's required properties are filtering up through connect()
//   https://github.com/DefinitelyTyped/DefinitelyTyped/issues/31363
/* eslint-disable @typescript-eslint/no-explicit-any */
const FilteredSmartTimelineItem = SmartTimelineItem as any;
const FilteredSmartTypingBubble = SmartTypingBubble as any;
const FilteredSmartLastSeenIndicator = SmartLastSeenIndicator as any;
const FilteredSmartHeroRow = SmartHeroRow as any;
const FilteredSmartTimelineLoadingRow = SmartTimelineLoadingRow as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

type ExternalProps = {
  id: string;

  // Note: most action creators are not wired into redux; for now they
  //   are provided by ConversationView in setupTimeline().
};

type AudioAttachmentProps = Omit<
  MessageAudioProps,
  'audio' | 'audioContext' | 'waveformCache'
>;

function renderItem(
  messageId: string,
  conversationId: string,
  actionProps: Record<string, unknown>
): JSX.Element {
  return (
    <FilteredSmartTimelineItem
      {...actionProps}
      conversationId={conversationId}
      id={messageId}
      renderEmojiPicker={renderEmojiPicker}
      renderAudioAttachment={renderAudioAttachment}
    />
  );
}

function renderAudioAttachment(props: AudioAttachmentProps) {
  return (
    <GlobalAudioContext.Consumer>
      {globalAudioProps => {
        return (
          globalAudioProps && (
            <SmartMessageAudio {...props} {...globalAudioProps} />
          )
        );
      }}
    </GlobalAudioContext.Consumer>
  );
}

function renderEmojiPicker({
  ref,
  onPickEmoji,
  onClose,
  style,
}: RenderEmojiPickerProps): JSX.Element {
  return (
    <SmartEmojiPicker
      ref={ref}
      onPickEmoji={onPickEmoji}
      onClose={onClose}
      style={style}
    />
  );
}
function renderLastSeenIndicator(id: string): JSX.Element {
  return <FilteredSmartLastSeenIndicator id={id} />;
}
function renderHeroRow(
  id: string,
  onHeightChange: () => unknown,
  updateSharedGroups: () => unknown
): JSX.Element {
  return (
    <FilteredSmartHeroRow
      id={id}
      onHeightChange={onHeightChange}
      updateSharedGroups={updateSharedGroups}
    />
  );
}
function renderLoadingRow(id: string): JSX.Element {
  return <FilteredSmartTimelineLoadingRow id={id} />;
}
function renderTypingBubble(id: string): JSX.Element {
  return <FilteredSmartTypingBubble id={id} />;
}

const mapStateToProps = (state: StateType, props: ExternalProps) => {
  const { id, ...actions } = props;

  const conversation = getConversationSelector(state)(id);
  const conversationMessages = getConversationMessagesSelector(state)(id);
  const selectedMessage = getSelectedMessage(state);

  return {
    id,
    ...pick(conversation, [
      'unreadCount',
      'typingContact',
      'isGroupV1AndDisabled',
    ]),
    ...conversationMessages,
    invitedContactsForNewlyCreatedGroup: getInvitedContactsForNewlyCreatedGroup(
      state
    ),
    selectedMessageId: selectedMessage ? selectedMessage.id : undefined,
    i18n: getIntl(state),
    renderItem,
    renderLastSeenIndicator,
    renderHeroRow,
    renderLoadingRow,
    renderTypingBubble,
    ...actions,
  };
};

const smart = connect(mapStateToProps, mapDispatchToProps);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SmartTimeline = smart(Timeline as any);
