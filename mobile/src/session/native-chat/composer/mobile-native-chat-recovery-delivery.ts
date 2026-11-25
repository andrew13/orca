import type { MobileNativeChatSendErrorReporter } from './delivery/use-mobile-native-chat-send-error'
import type {
  MobileStructuredSendConfirmation,
  MobileStructuredSendRecord
} from './delivery/mobile-structured-send-recorded-read'
import type { AgentSessionDeliveryFact } from '../../../../../src/shared/agent-session/requests/structured-agent-session-send-settlement'
import { readWholeAgentSessionFailureFact } from '../../../../../src/shared/agent-session/failures/agent-session-failure'
import { structuredAgentSessionRejectionParts } from '../../../../../src/shared/agent-session/failures/structured-agent-session-rejection-words'
import { mobileAgentSessionWriteNoticeText } from '../agent-session/agent-session-write-notice-copy'
import {
  readMobileNativeChatInFlightStructuredSession,
  mobileRecoveryQueueOwns,
  markMobileNativeChatInFlightUnconfirmed,
  releaseMobileNativeChatInFlightSends,
  settleMobileNativeChatInFlightSend,
  settleRecordedMobileNativeChatInFlightSends
} from './delivery/mobile-native-chat-in-flight-sends'
import { UNCONFIRMED_SEND_MESSAGE } from './delivery/use-mobile-native-chat-unconfirmed-sends'

export function settleMobileInstructionRecovery(
  sessionId: string | null,
  submissions: readonly AgentSessionDeliveryFact[],
  onSendError: MobileNativeChatSendErrorReporter,
  queuedMessageIds: readonly string[]
): void {
  if (!sessionId || submissions.length === 0) {
    return
  }
  const sends = readMobileNativeChatInFlightStructuredSession(sessionId)
  if (sends.length === 0) {
    return
  }
  const byId = new Map(submissions.map((submission) => [submission.clientMessageId, submission]))
  const queued = new Set(queuedMessageIds)
  for (const send of sends) {
    const submission = send.clientMessageId && byId.get(send.clientMessageId)
    if (
      !submission ||
      submission.dispatchState === 'pending' ||
      submission.dispatchState === 'unknown'
    ) {
      continue
    }
    const fact = readWholeAgentSessionFailureFact(submission.rejection)
    const failedRecovery = submission.dispatchState === 'rejected' && fact?.instructionRecovery
    const owned =
      queued.has(submission.clientMessageId) || mobileRecoveryQueueOwns(submission, queued)
    if (failedRecovery && !owned) {
      continue
    }
    settleMobileNativeChatInFlightSend(
      send.id,
      submission.dispatchState === 'accepted' || owned ? 'sent' : 'kept'
    )
    if (failedRecovery) {
      const message = mobileAgentSessionWriteNoticeText(
        structuredAgentSessionRejectionParts(submission.reason, 'send', fact, {
          agentName: 'Codex'
        })
      )
      onSendError(message, { announceOnly: true })
    }
  }
}

export function confirmMobileRecordedRecovery({
  confirm,
  clientMessageId,
  inFlightIds,
  handBack,
  checked,
  forgetLocalEcho,
  readDelivery,
  sessionId,
  onSendError
}: {
  confirm: MobileStructuredSendConfirmation | null
  clientMessageId: string
  inFlightIds: () => string[]
  handBack: () => void
  checked: Map<string, boolean>
  forgetLocalEcho: (id: string) => void
  readDelivery: () => {
    submissions: readonly AgentSessionDeliveryFact[]
    queuedMessageIds: readonly string[]
  } | null
  sessionId: string | null
  onSendError: MobileNativeChatSendErrorReporter
}): void {
  if (checked.get(clientMessageId) || (!confirm && checked.has(clientMessageId))) {
    return
  }
  checked.set(clientMessageId, Boolean(confirm))
  const settle = (onHost?: MobileStructuredSendRecord) => {
    const ids = inFlightIds()
    if (onHost?.recorded) {
      const facts =
        onHost.submission?.clientMessageId === clientMessageId
          ? [onHost.submission]
          : (readDelivery()?.submissions ?? [])
      const queuedMessageIds = onHost.ownedByQueue ? [clientMessageId] : []
      settleMobileInstructionRecovery(sessionId, facts, onSendError, queuedMessageIds)
      settleRecordedMobileNativeChatInFlightSends(ids, facts, true, queuedMessageIds)
      forgetLocalEcho(clientMessageId)
    } else if (onHost?.confirmedAbsent) {
      const current = readDelivery()
      if (
        current &&
        !current.submissions.some((entry) => entry.clientMessageId === clientMessageId) &&
        !current.queuedMessageIds.includes(clientMessageId)
      ) {
        handBack()
      }
    } else if (markMobileNativeChatInFlightUnconfirmed(ids)) {
      forgetLocalEcho(clientMessageId)
      onSendError(UNCONFIRMED_SEND_MESSAGE)
    }
    releaseMobileNativeChatInFlightSends(ids)
  }
  if (confirm) {
    void confirm(clientMessageId).then(settle)
  } else {
    settle()
  }
}
