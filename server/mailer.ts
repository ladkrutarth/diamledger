import nodemailer from 'nodemailer';

export type SendPasswordResetEmail = (to: string, link: string) => Promise<void>;

export const sendPasswordResetEmail: SendPasswordResetEmail = async (to, link) => {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.warn(`Password reset requested for ${to}. SMTP is not configured, so the link was not emailed: ${link}`);
    return;
  }

  const port = Number(SMTP_PORT) || 587;
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to,
    subject: 'Reset your DiamondX password',
    text: `Use this link to choose a new password. It expires in 1 hour.\n\n${link}\n\nIf you did not ask for this, ignore this email.`,
  });
};
