import type { Express } from 'express';
import nodemailer from 'nodemailer';
import { GoogleGenAI, Type } from '@google/genai';
import { requireUser } from './auth.js';

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

export function registerLegacyRoutes(app: Express): void {
  app.post('/api/parse-manifest', requireUser, async (req, res) => {
    try {
      const { manifestText, imageBase64, mimeType } = req.body;

      if (!manifestText && !imageBase64) {
        return res.status(400).json({ error: 'Please provide manifest text, CSV, or an image file.' });
      }

      const systemPrompt = `You are a Senior Customs Compliance Officer and GJEPC Diamond Trade Specialist. 
Analyze diamond parcel manifests, grading reports (GIA, IGI, HRD), rough/polished lot lists, or commercial slips.
Extract structured diamond export line items and invoice metadata with extreme precision.
Standard HS codes:
- 7102.39.10: Cut & Polished Natural Earth-Mined Diamonds
- 7102.31.00: Unworked / Rough Diamonds
- 7102.10.00: Unsorted Diamonds
Default to HS Code "7102.39.10" if not specified.
Always extract exact carats (e.g. 1.25, 2.504), pieces, rate per carat in USD, total amount (carats * rate), lab certificate numbers, parcel IDs, and shape/color/clarity.`;

      const contents: any[] = [];

      if (imageBase64) {
        contents.push({
          inlineData: {
            mimeType: mimeType || 'image/jpeg',
            data: imageBase64.replace(/^data:[a-zA-Z0-9/+-]+;base64,/, ''),
          },
        });
      }

      contents.push({
        text: manifestText
          ? `Parse this diamond parcel manifest data into invoice line items and shipment metadata:\n\n${manifestText}`
          : 'Please analyze this diamond parcel manifest image/document and extract the diamond line items, carats, rates, certificates, and lot numbers.',
      });

      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: { parts: contents },
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              consigneeName: { type: Type.STRING, description: 'Consignee or buyer firm name if detected' },
              portOfDestination: { type: Type.STRING, description: 'Destination port or city (e.g. Antwerp, Dubai, New York, Hong Kong)' },
              kpcsNumber: { type: Type.STRING, description: 'Kimberley Process Certificate number if detected' },
              items: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    description: { type: Type.STRING, description: 'Full diamond description e.g. Cut & Polished Natural Diamonds - Round Brilliant VVS1/E' },
                    hsCode: { type: Type.STRING, description: 'HS / HSN Code (e.g. 7102.39.10)' },
                    certificateNo: { type: Type.STRING, description: 'GIA, IGI or HRD certificate number' },
                    parcelId: { type: Type.STRING, description: 'Lot number or parcel tag' },
                    pieces: { type: Type.INTEGER, description: 'Number of pieces (pcs)' },
                    carats: { type: Type.NUMBER, description: 'Weight in carats (cts)' },
                    ratePerCarat: { type: Type.NUMBER, description: 'Price per carat in USD' },
                  },
                  required: ['description', 'hsCode', 'pieces', 'carats', 'ratePerCarat'],
                },
              },
              notes: { type: Type.STRING, description: 'Summary notes or grading remarks' },
            },
            required: ['items'],
          },
        },
      });

      const parsedData = JSON.parse(response.text || '{}');
      return res.json({ success: true, data: parsedData });
    } catch (error: any) {
      console.error('Error in /api/parse-manifest:', error);
      return res.status(500).json({
        error: error.message || 'Failed to parse diamond manifest via Gemini API.',
      });
    }
  });

  app.post('/api/send-email', requireUser, async (req, res) => {
    try {
      const { smtpConfig, emailData, attachments } = req.body;

      if (!emailData || !emailData.recipients || emailData.recipients.length === 0) {
        return res.status(400).json({ error: 'At least one recipient email is required.' });
      }

      const { host, port: smtpPort, secure, user, pass, fromEmail, fromName } = smtpConfig || {};

      if (!host || !user || !pass) {
        const logEntry = {
          status: 'simulated_success',
          message: 'Email generated and queued in DiamondX Dispatch Gateway. (To send real external emails, enter valid SMTP credentials).',
          timestamp: new Date().toISOString(),
          recipients: emailData.recipients,
          cc: emailData.cc || [],
          subject: emailData.subject,
          attachmentsCount: attachments?.length || 0,
          invoiceNumber: emailData.invoiceNumber,
        };
        return res.json({ success: true, mode: 'preview_simulated', log: logEntry });
      }

      const transporter = nodemailer.createTransport({
        host: host.trim(),
        port: Number(smtpPort) || 587,
        secure: Boolean(secure),
        auth: {
          user: user.trim(),
          pass: pass.trim(),
        },
        tls: {
          rejectUnauthorized: false,
        },
      });

      const mailAttachments = (attachments || []).map((att: any) => ({
        filename: att.filename,
        content: Buffer.from(att.content.replace(/^data:[^;]+;base64,/, ''), 'base64'),
        contentType: att.contentType || 'application/pdf',
      }));

      const mailOptions: any = {
        from: `"${fromName || 'DiamondX Customs Desk'}" <${fromEmail || user}>`,
        to: Array.isArray(emailData.recipients) ? emailData.recipients.join(', ') : emailData.recipients,
        subject: emailData.subject,
        html: emailData.htmlBody,
        attachments: mailAttachments,
      };

      if (emailData.cc && emailData.cc.length > 0) {
        mailOptions.cc = Array.isArray(emailData.cc) ? emailData.cc.join(', ') : emailData.cc;
      }

      const info = await transporter.sendMail(mailOptions);

      return res.json({
        success: true,
        messageId: info.messageId,
        accepted: info.accepted,
        mode: 'live_smtp',
      });
    } catch (error: any) {
      console.error('SMTP Dispatch error:', error);
      return res.status(500).json({
        error: error.message || 'Failed to dispatch email via SMTP server.',
      });
    }
  });

  app.post('/api/verify-smtp', requireUser, async (req, res) => {
    try {
      const { host, port: smtpPort, secure, user, pass } = req.body;

      if (!host || !user || !pass) {
        return res.status(400).json({ error: 'Host, Username, and Password are required.' });
      }

      const transporter = nodemailer.createTransport({
        host: host.trim(),
        port: Number(smtpPort) || 587,
        secure: Boolean(secure),
        auth: {
          user: user.trim(),
          pass: pass.trim(),
        },
        tls: {
          rejectUnauthorized: false,
        },
      });

      await transporter.verify();
      return res.json({ success: true, message: 'SMTP connection verified successfully.' });
    } catch (error: any) {
      return res.status(400).json({
        success: false,
        error: error.message || 'SMTP Connection failed. Verify host, port, and security credentials.',
      });
    }
  });
}
