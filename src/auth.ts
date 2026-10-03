import { Request, Response, NextFunction } from 'express';
import { hashSessionToken } from './crypto.js';
import { store } from './store.js';

declare global {
  namespace Express {
    interface Request {
      userId?: string;
      isPaidUser?: boolean;
      role?: 'user' | 'admin';
      adminLevel?: 'primary' | 'secondary';
    }
  }
}

export function sessionIdentity(req: Request, _res: Response, next: NextFunction): void {
  const authorization = req.header('authorization') ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const user = token ? store.getAuthSessionUser(hashSessionToken(token)) : undefined;
  if (user) {
    req.userId = user.id;
    req.role = user.role;
    req.adminLevel = user.adminLevel;
    req.isPaidUser = user.paid || user.role === 'admin';
  }
  next();
}

export function requirePaidUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  if (!req.isPaidUser) {
    res.status(403).json({ error: '该功能仅对已付费账户开放' });
    return;
  }
  next();
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId) {
    res.status(401).json({ error: '请先登录' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId || req.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

export function requirePrimaryAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId || req.role !== 'admin') {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  if (req.adminLevel !== 'primary') {
    res.status(403).json({ error: '该功能仅限主管理员使用' });
    return;
  }
  next();
}
