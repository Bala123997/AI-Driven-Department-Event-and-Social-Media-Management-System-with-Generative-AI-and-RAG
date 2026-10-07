import nodemailer from 'nodemailer';

function isEmailEnabled() {
  return String(process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';
}

function createTransporter() {
  if (!isEmailEnabled()) return null;

  const host = String(process.env.SMTP_HOST || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();

  if (!host || !user || !pass) {
    console.warn('Email notifications are enabled but SMTP configuration is incomplete. Skipping email delivery.');
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: {
      user,
      pass,
    },
  });
}

export async function sendBulkEmail({ recipients = [], subject, text, html }) {
  if (!Array.isArray(recipients) || !recipients.length) return { sent: 0, attempted: 0, skipped: true, reason: 'no_recipients' };
  if (!isEmailEnabled()) {
    return { sent: 0, attempted: 0, skipped: true, reason: 'email_disabled' };
  }

  const transporter = createTransporter();
  if (!transporter) {
    return { sent: 0, attempted: 0, skipped: true, reason: 'smtp_configuration_incomplete' };
  }

  const validRecipients = recipients
    .map((recipient) => String(recipient || '').trim())
    .filter((recipient) => recipient && recipient.includes('@'));

  if (!validRecipients.length) {
    return { sent: 0, attempted: 0, skipped: true, reason: 'invalid_recipients' };
  }

  let sentCount = 0;
  const failures = [];

  for (const recipient of validRecipients) {
    try {
      const info = await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'Department Social Platform <noreply@example.com>',
        to: recipient,
        subject,
        text,
        html: html || `<p>${String(text || '').replace(/\n/g, '<br />')}</p>`,
      });
      if (info && info.accepted && info.accepted.length) {
        sentCount += 1;
      }
    } catch (error) {
      failures.push(recipient);
      console.warn(`Email notification delivery failed for ${recipient}.`, error.message || error);
    }
  }

  return {
    sent: sentCount,
    attempted: validRecipients.length,
    skipped: false,
    failed: failures,
  };
}
