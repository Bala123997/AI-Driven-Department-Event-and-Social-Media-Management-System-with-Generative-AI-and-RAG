const DEFAULT_EVENT_DETAILS = {
  action: 'SYSTEM',
  eventName: 'Department Event',
  recipientRole: 'User',
  actionPerformer: 'System',
  eventDate: null,
  eventTime: null,
  venue: null,
  rejectionReason: null,
};

function normalizeText(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

export function buildNotificationMessage(context = {}) {
  const details = { ...DEFAULT_EVENT_DETAILS, ...context };
  const eventName = normalizeText(details.eventName, 'the event');
  const recipientRole = normalizeText(details.recipientRole, 'User');
  const performer = normalizeText(details.actionPerformer, 'the system');
  const eventDate = normalizeText(details.eventDate, '');
  const venue = normalizeText(details.venue, '');
  const reason = normalizeText(details.rejectionReason, '');

  switch (details.action) {
    case 'POST_SUBMITTED':
      return `New Post Awaiting Approval: ${eventName} submitted by the Student Coordinator is waiting for your review.`;
    case 'POST_APPROVED':
      if (recipientRole === 'Student Coordinator') {
        return `Post Approved: Your ${eventName} event has been approved by Faculty.`;
      }
      if (recipientRole === 'General User') {
        return `New Event: ${eventName} has been approved and is now available. Check the event details for more information.`;
      }
      return `Post Approved: ${eventName} submitted by the Student Coordinator has been approved.`;
    case 'POST_REJECTED':
      if (reason) {
        return `Post Rejected: Your ${eventName} submission was rejected because ${reason} Please update the post and resubmit it.`;
      }
      return `Post Rejected: Your ${eventName} submission was rejected. Please update the post and resubmit it.`;
    case 'GENERAL_EVENT_APPROVED':
      if (eventDate) {
        return `New Event: ${eventName} has been approved and is scheduled for ${eventDate}${eventTime ? ` at ${eventTime}` : ''}${venue ? ` at ${venue}` : ''}.`;
      }
      return `New Event: ${eventName} has been approved and is now available.`;
    case 'ADMIN_ALERT':
      return `System Update: ${eventName} was ${details.action === 'ADMIN_ALERT' ? 'updated' : 'processed'} by ${performer}.`;
    default:
      return `Update: ${eventName} was processed for ${recipientRole}.`;
  }
}

export async function generateNotificationText(context = {}) {
  const fallback = buildNotificationMessage(context);
  const apiKey = String(process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '').trim();
  if (!apiKey) return fallback;

  const timeoutMs = Math.max(1000, Number(process.env.AI_NOTIFICATION_TIMEOUT_MS || 8000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    model: process.env.LLM_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'You create short, professional notification messages using only the provided facts. Never invent a title, date, venue, or person. Return only the notification text without markdown or bullet points.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          action: context.action || 'SYSTEM',
          eventName: context.eventName || 'Department Event',
          eventDate: context.eventDate || null,
          eventTime: context.eventTime || null,
          venue: context.venue || null,
          recipientRole: context.recipientRole || 'User',
          actionPerformer: context.actionPerformer || 'System',
          rejectionReason: context.rejectionReason || null,
        }, null, 2),
      },
    ],
  };

  try {
    const response = await fetch(process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`AI provider returned ${response.status}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const generated = normalizeText(content || '', '');
    if (!generated) return fallback;
    return generated.replace(/\s+/g, ' ').trim();
  } catch (error) {
    console.warn('AI notification generation failed. Using fallback message.', error.message || error);
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}
