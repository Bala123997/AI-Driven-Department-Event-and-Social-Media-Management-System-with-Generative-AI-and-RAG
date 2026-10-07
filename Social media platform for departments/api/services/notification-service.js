import { generateNotificationText, buildNotificationMessage } from './notification-generator.js';
import { sendBulkEmail } from './email-notification.js';

export async function getActiveUsersByRoleNames(database, roleNames = []) {
  if (!Array.isArray(roleNames) || !roleNames.length) return [];
  const uniqueRoleNames = [...new Set(roleNames.filter(Boolean))];
  if (!uniqueRoleNames.length) return [];
  const placeholders = uniqueRoleNames.map(() => '?').join(', ');
  const [rows] = await database.execute(
    `SELECT DISTINCT u.user_id, u.full_name, u.email, r.role_name
       FROM users u
       JOIN roles r ON r.role_id = u.role_id
      WHERE u.status = 'active' AND r.role_name IN (${placeholders})`,
    uniqueRoleNames,
  );
  return rows;
}

export async function createNotificationsForRoleUsers({
  database,
  roleNames = [],
  postId = null,
  notificationType = 'system',
  title,
  message,
  recipients = [],
}) {
  const userRows = recipients.length
    ? recipients
    : await getActiveUsersByRoleNames(database, roleNames);

  if (!userRows.length || !message) return [];

  const uniqueUserIds = [...new Set(userRows.map((user) => Number(user.user_id)).filter(Boolean))];
  if (!uniqueUserIds.length) return [];

  const values = [];
  uniqueUserIds.forEach((userId) => {
    values.push(userId, postId, notificationType, title, message);
  });

  await database.execute(
    `INSERT INTO notifications (user_id, post_id, notification_type, title, message, is_read, created_at)
     VALUES ${uniqueUserIds.map(() => '(?, ?, ?, ?, ?, 0, NOW())').join(', ')}`,
    values,
  );

  return uniqueUserIds;
}

function titleForAction(action, eventName) {
  switch (action) {
    case 'POST_SUBMITTED':
      return `"${eventName}" submitted for approval`;
    case 'POST_APPROVED':
      return `"${eventName}" approved`;
    case 'POST_REJECTED':
      return `"${eventName}" rejected`;
    case 'GENERAL_EVENT_APPROVED':
      return `New event: ${eventName}`;
    default:
      return eventName || 'Department update';
  }
}

export async function dispatchNotification({
  database,
  action,
  eventName,
  recipientRoleNames = [],
  actionPerformer = 'System',
  postId = null,
  rejectionReason = null,
  eventDate = null,
  eventTime = null,
  venue = null,
  notificationType = 'system',
  customTitle = null,
  customMessage = null,
  sendEmail = true,
}) {
  const normalizedAction = String(action || 'SYSTEM');
  const roleNames = [...new Set(recipientRoleNames.filter(Boolean))];
  if (!roleNames.length) return [];

  const generatedMessage = customMessage || (await generateNotificationText({
    action: normalizedAction,
    eventName,
    recipientRole: roleNames.join(', '),
    actionPerformer,
    eventDate,
    eventTime,
    venue,
    rejectionReason,
  }));

  const title = customTitle || titleForAction(normalizedAction, eventName);
  const recipients = await getActiveUsersByRoleNames(database, roleNames);
  if (!recipients.length) return [];

  const userIds = await createNotificationsForRoleUsers({
    database,
    roleNames,
    postId,
    notificationType,
    title,
    message: generatedMessage,
    recipients,
  });

  if (sendEmail) {
    const emails = recipients
      .map((user) => user.email)
      .filter((email) => typeof email === 'string' && email.includes('@'));
    if (emails.length) {
      try {
        const delivery = await sendBulkEmail({
          recipients: emails,
          subject: title,
          text: generatedMessage,
        });
        if (delivery.sent !== emails.length) {
          console.warn('Email notification delivery incomplete.', {
            sent: delivery.sent,
            attempted: delivery.attempted,
            failed: delivery.failed?.length || 0,
            reason: delivery.reason,
          });
        } else {
          console.info(`Email notification delivered to ${delivery.sent} recipient(s).`);
        }
      } catch (error) {
        console.warn('Email notification delivery failed; in-app notification was saved.', error.message || error);
      }
    } else {
      console.warn('Email notification skipped because no valid recipient email addresses were found.');
    }
  }

  return userIds;
}

export function fallbackNotificationMessage(context = {}) {
  return buildNotificationMessage(context);
}
