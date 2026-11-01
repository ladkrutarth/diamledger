import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi } from '../../server/vercelHandler';

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  handleApi(req, res, '/api/auth/register');
}
