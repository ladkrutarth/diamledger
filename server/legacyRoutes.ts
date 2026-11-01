import type { Express } from 'express';
import { Type } from '@google/genai';
import { requireUser } from './auth.js';
import { callModel, usageFrom } from './ai/call.js';
import { AiUnavailableError, GEMINI_MODEL, gemini } from './ai/client.js';
import type { DbPool } from './db.js';
import { currentUser } from './http.js';

const MANIFEST_PROMPT_VERSION = 'manifest-v1';

export function registerLegacyRoutes(app: Express, pool: DbPool): void {
  app.post('/api/parse-manifest', requireUser, async (req, res) => {
    const user = currentUser(res);
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

      const context = {
        feature: 'manifest_parser' as const,
        promptVersion: MANIFEST_PROMPT_VERSION,
        model: GEMINI_MODEL,
        organizationId: user.organizationId,
        userId: user.id,
      };
      const response = await callModel(pool, context, async (signal) => {
        const result = await gemini().models.generateContent({
        model: GEMINI_MODEL,
        contents: { parts: contents },
        config: {
          abortSignal: signal,
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
        return { value: result, usage: usageFrom(result.usageMetadata) };
      });

      const parsedData = JSON.parse(response.text || '{}');
      return res.json({ success: true, data: parsedData });
    } catch (error: any) {
      if (error instanceof AiUnavailableError) {
        return res.status(503).json({ error: error.message });
      }
      console.error('Error in /api/parse-manifest:', error);
      return res.status(500).json({
        error: error.message || 'Failed to parse diamond manifest via Gemini API.',
      });
    }
  });
}
