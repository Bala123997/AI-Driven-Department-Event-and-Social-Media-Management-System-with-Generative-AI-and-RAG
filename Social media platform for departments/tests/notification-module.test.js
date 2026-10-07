import test from 'node:test';
import assert from 'node:assert/strict';

import { generateNotificationText, buildNotificationMessage } from '../api/services/notification-generator.js';

test('generateNotificationText returns a sensible fallback for submitted posts', async () => {
  const result = await generateNotificationText({
    action: 'POST_SUBMITTED',
    eventName: 'AI Workshop',
    recipientRole: 'Faculty',
    actionPerformer: 'Student Coordinator',
  });

  assert.ok(result.length > 20);
  assert.match(result.toLowerCase(), /ai workshop|approval|review/);
});

test('buildNotificationMessage keeps rejection reason when present', () => {
  const result = buildNotificationMessage({
    action: 'POST_REJECTED',
    eventName: 'AI Workshop',
    recipientRole: 'Student Coordinator',
    actionPerformer: 'Faculty',
    rejectionReason: 'Venue information is missing.',
  });

  assert.match(result.toLowerCase(), /rejected|venue information is missing/);
});
