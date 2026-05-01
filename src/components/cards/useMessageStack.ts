import { useState, useEffect, useCallback } from 'react';
import type { Message } from '../../types';

// Geometry + selection state for the layered chat-card stack. The
// underlying card is 230×400; each additional message adds an offset layer
// behind the front overlay, evenly distributed up to a 36px total shift.
export function useMessageStack(messages: Message[]) {
  const messageCount = messages.length;
  const [rawSelectedIdx, setSelectedIdx] = useState(messageCount - 1);

  // When new messages arrive, jump to the latest
  useEffect(() => {
    setSelectedIdx(messageCount - 1);
  }, [messageCount]);

  const selectedIdx = Math.min(
    Math.max(rawSelectedIdx, 0),
    Math.max(messageCount - 1, 0)
  );
  const selectedMessage = messageCount > 0 ? messages[selectedIdx] : null;
  const isLatestSelected = selectedIdx === messageCount - 1;

  const layerCount = Math.max(messageCount - 1, 0);
  const offsetPx =
    layerCount === 0 ? 0 : Math.max(2, Math.min(4, Math.floor(36 / layerCount)));
  const totalShift = layerCount * offsetPx;
  const positionFor = useCallback(
    (idx: number) => (messageCount - 1 - idx) * offsetPx,
    [messageCount, offsetPx]
  );
  const overlayPos = messageCount > 0 ? positionFor(selectedIdx) : 0;

  const cycle = useCallback(
    (delta: number) => {
      setSelectedIdx((cur) => {
        const next = cur + delta;
        if (next < 0) return 0;
        if (next > messageCount - 1) return messageCount - 1;
        return next;
      });
    },
    [messageCount]
  );

  return {
    messageCount,
    selectedIdx,
    selectedMessage,
    isLatestSelected,
    setSelectedIdx,
    cycle,
    totalShift,
    overlayPos,
    positionFor,
  };
}
