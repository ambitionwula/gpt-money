export type MailProvider = '163' | '126' | 'yeah';

export type UserRole = 'user' | 'admin';
export type AdminLevel = 'primary' | 'secondary';

export interface User {
  id: string;
  role: UserRole;
  adminLevel?: AdminLevel;
  adminActive?: boolean;
  paid: boolean;
  paidUntil?: number;
  planId?: string;
  maxMailAccounts: number;
  canViewMailCredentials: boolean;
  createdAt: number;
}

export interface AuthUser {
  id: string;
  role: UserRole;
  adminLevel?: AdminLevel;
  adminActive?: boolean;
  paid: boolean;
  paidUntil?: number;
  maxMailAccounts: number;
}

export type PaymentStatus = 'pending' | 'paid' | 'closed';

export interface PaymentOrder {
  id: string;
  userId: string;
  planId: string;
  amountFen: number;
  status: PaymentStatus;
  paymentMethod?: string;
  providerTradeNo?: string;
  adminNote?: string;
  createdAt: number;
  paidAt?: number;
}

export interface PaymentPlan {
  id: string;
  name: string;
  seatCount: number;
  displaySeatCount: number;
  amountFen: number;
  durationDays: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentSettings {
  id: string;
  enabled: boolean;
  gatewayType: 'epay' | 'manual';
  gatewayUrl: string;
  callbackBaseUrl: string;
  returnUrl: string;
  merchantId: string;
  encryptedMerchantKey: string;
  minAmountFen: number;
  updatedAt: number;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  active: boolean;
  priority: number;
  startsAt: number;
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MailConnection {
  id: string;
  userId: string;
  email: string;
  encryptedAppPassword: string;
  provider: MailProvider;
  createdAt: number;
}

export interface ManagedMailAccount extends MailConnection {
  encryptedLoginPassword?: string;
  note: string;
  maxUsers: number;
  active: boolean;
  expiresAt: number;
}

export type MailAssignmentSource = 'auto' | 'admin';

export interface MailAssignment {
  userId: string;
  accountId: string;
  source: MailAssignmentSource;
  createdAt: number;
  account: ManagedMailAccount;
}

export type OtpRequestStatus = 'pending' | 'found' | 'expired' | 'failed';

export interface OtpRequest {
  id: string;
  userId: string;
  connectionId: string;
  status: OtpRequestStatus;
  codeHash?: string;
  createdAt: number;
  expiresAt: number;
  consumedAt?: number;
  error?: string;
}

export type SupportTicketStatus = 'open' | 'pending' | 'closed';
export type SupportMessageSender = 'user' | 'admin' | 'ai';

export interface SupportTicket {
  id: string;
  userId: string;
  subject: string;
  status: SupportTicketStatus;
  createdAt: number;
  updatedAt: number;
}

export interface SupportMessage {
  id: string;
  ticketId: string;
  senderType: SupportMessageSender;
  senderId: string;
  content: string;
  attachment?: {
    fileName: string;
    originalName: string;
    mimeType: string;
    size: number;
  };
  createdAt: number;
}

export interface SupportAiConfig {
  id: string;
  baseUrl: string;
  model: string;
  encryptedApiKey: string;
  active: boolean;
  updatedAt: number;
}
