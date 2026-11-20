import { describe, expect, it } from 'vitest';
import {
  buildPasswordChangedEmail,
  buildPasswordResetEmail,
  buildVerificationEmail,
  sendVerificationEmail,
} from '../../src/services/email.service';

describe('email contents', () => {
  it('puts the verification link on your frontend, with the token', () => {
    const mail = buildVerificationEmail('Sabir', 'abc123');
    expect(mail.subject).toBe('Verify your email address');
    expect(mail.text).toContain('Verify email: http://localhost:5173/verify-email?token=abc123');
    expect(mail.html).toContain('http://localhost:5173/verify-email?token=abc123');
    expect(mail.text).toContain('24 hours');
  });

  it('puts the reset link on your frontend and says how long it works', () => {
    const mail = buildPasswordResetEmail('Sabir', 'xyz789');
    expect(mail.text).toContain('Choose a new password: http://localhost:5173/reset-password?token=xyz789');
    expect(mail.text).toContain('30 minutes');
  });

  it('tells people when their password changed', () => {
    const mail = buildPasswordChangedEmail('Sabir');
    expect(mail.subject).toBe('Your password was changed');
    expect(mail.text).toContain('Hi Sabir');
  });

  it('escapes names, so nobody can inject HTML into an email', () => {
    const mail = buildVerificationEmail('<script>alert(1)</script>', 'abc');
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('&lt;script&gt;');
  });

  it('encodes odd characters in the token part of the link', () => {
    const mail = buildVerificationEmail('Sabir', 'a b&c');
    expect(mail.text).toContain('token=a%20b%26c');
  });

  it('does not fail when no mail server is configured (it only logs)', async () => {
    await expect(sendVerificationEmail('someone@example.com', 'Someone', 'abc')).resolves.toBe(true);
  });
});