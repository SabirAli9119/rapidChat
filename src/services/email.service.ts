import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface MailContent {
  subject: string;
  text: string;
  html: string;
}

const baseUrl = env.FRONTEND_URL.replace(/\/+$/, '');

/** Prevents injected HTML: user-controlled values (like display names) are always escaped. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface EmailLayout {
  heading: string;
  paragraphs: string[];
  button?: { label: string; link: string };
  footnote: string;
}

function renderEmail(layout: EmailLayout): { html: string; text: string } {
  const paragraphsHtml = layout.paragraphs
    .map((p) => `<p style="margin:0 0 16px;line-height:1.5">${escapeHtml(p)}</p>`)
    .join('');

  const buttonHtml = layout.button
    ? `<p style="margin:24px 0"><a href="${escapeHtml(layout.button.link)}" style="background:#2563eb;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(layout.button.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#555">Or copy this link into your browser:<br>${escapeHtml(layout.button.link)}</p>`
    : '';

  const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111">
    <h2 style="margin:0 0 16px">${escapeHtml(layout.heading)}</h2>
    ${paragraphsHtml}${buttonHtml}
    <p style="margin:24px 0 0;font-size:12px;color:#777">${escapeHtml(layout.footnote)}</p>
  </div>`;

  const text = [
    layout.heading,
    '',
    ...layout.paragraphs,
    ...(layout.button ? ['', `${layout.button.label}: ${layout.button.link}`] : []),
    '',
    layout.footnote,
  ].join('\n');

  return { html, text };
}

// ---------- Email builders (pure functions: easy to test) ----------

export function buildVerificationEmail(displayName: string, token: string): MailContent {
  const link = `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const { html, text } = renderEmail({
    heading: 'Verify your email address',
    paragraphs: [
      `Hi ${displayName}, welcome to Nearby Chat!`,
      `Please confirm your email address to finish setting up your account. This link works for ${env.EMAIL_VERIFICATION_EXPIRES_HOURS} hours.`,
    ],
    button: { label: 'Verify email', link },
    footnote: "If you didn't create this account, you can ignore this email.",
  });
  return { subject: 'Verify your email address', text, html };
}

export function buildPasswordResetEmail(displayName: string, token: string): MailContent {
  const link = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  const { html, text } = renderEmail({
    heading: 'Reset your password',
    paragraphs: [
      `Hi ${displayName}, we received a request to reset your password.`,
      `This link works for ${env.PASSWORD_RESET_EXPIRES_MINUTES} minutes and can be used only once.`,
    ],
    button: { label: 'Choose a new password', link },
    footnote: "If you didn't ask for this, ignore this email. Your password has not changed.",
  });
  return { subject: 'Reset your password', text, html };
}

export function buildPasswordChangedEmail(displayName: string): MailContent {
  const { html, text } = renderEmail({
    heading: 'Your password was changed',
    paragraphs: [
      `Hi ${displayName}, the password for your Nearby Chat account was just changed, and you were logged out of your other devices.`,
    ],
    footnote: "If this wasn't you, reset your password immediately and contact support.",
  });
  return { subject: 'Your password was changed', text, html };
}

// ---------- Delivery ----------

let transporter: Transporter | null | undefined;

function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;

  transporter =
    env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS
      ? nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_PORT === 465, // 465 = TLS from the start; other ports upgrade with STARTTLS
          auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        })
      : null;

  return transporter;
}

/** Sends an email. Returns false on failure, and never throws. */
async function deliver(to: string, content: MailContent): Promise<boolean> {
  const transport = getTransporter();

  if (!transport) {
    // Development convenience: show the email (and its link) in the terminal
    logger.info(
      { to, subject: content.subject, text: content.text },
        'SMTP not configured: email NOT sent, printing it here instead',
    );
    return true;
  }

  try {
    await transport.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });
    return true;
  } catch (err) {
    logger.error({ err, subject: content.subject }, 'Failed to send email');
    return false;
  }
}

export const sendVerificationEmail = (to: string, displayName: string, token: string): Promise<boolean> =>
  deliver(to, buildVerificationEmail(displayName, token));

export const sendPasswordResetEmail = (to: string, displayName: string, token: string): Promise<boolean> =>
  deliver(to, buildPasswordResetEmail(displayName, token));

export const sendPasswordChangedEmail = (to: string, displayName: string): Promise<boolean> =>
  deliver(to, buildPasswordChangedEmail(displayName));