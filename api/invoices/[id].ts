import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from '../../server/vercelHandler';

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  const raw = req.url || '';
  const pathname = raw.split('?')[0];
  const params = new URL(raw, 'http://localhost').searchParams;
  const fromPath = pathname.split('/').filter(Boolean).pop();
  const id = params.get('id') || (fromPath && fromPath !== 'invoices' ? fromPath : '');
  handleApi(req, res, `/api/invoices/${id}`);
}
