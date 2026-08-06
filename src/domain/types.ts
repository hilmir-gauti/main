/**
 * Shared domain types.
 *
 * These mirror the database schema but use JavaScript-natural types (booleans
 * rather than 0/1, parsed JSON rather than strings). The mapping happens in
 * each domain module's `row → entity` function.
 */

import type { Instant, MinuteOfDay, PlainDate, Weekday } from '../core/time.ts';

export type TenantStatus = 'undirbuningur' | 'virkur' | 'i_bid' | 'haett';

/** Features the operator ticks on during onboarding. */
export const FEATURES = [
  'vefsida',
  'bokanir',
  'google_calendar',
  'tolvupostur',
  'simsvorun',
  'sms',
  'app_tilkynningar',
] as const;
export type Feature = (typeof FEATURES)[number];

export const FEATURE_LABELS: Record<Feature, { label: string; description: string }> = {
  vefsida: {
    label: 'Vefsíða',
    description: 'Sjálfvirkt gerð vefsíða með þjónustulista, opnunartíma og bókunarkerfi.',
  },
  bokanir: {
    label: 'Bókanakerfi',
    description: 'Netbókanir með lausum tímum, staðfestingum og afbókunartengli.',
  },
  google_calendar: {
    label: 'Google Calendar',
    description: 'Tvíhliða samstilling: bókanir birtast í dagatali og einkatímar loka á bókanir.',
  },
  tolvupostur: {
    label: 'Tölvupóstur',
    description: 'Fyrirtækjanetfang (Google Workspace eða Proton) og sjálfvirkur staðfestingarpóstur.',
  },
  simsvorun: {
    label: 'Símsvörun',
    description: 'Símsvari sem svarar á íslensku, bókar tíma og tekur skilaboð utan opnunartíma.',
  },
  sms: {
    label: 'SMS-áminningar',
    description: 'Áminning í síma viðskiptavinar sólarhring fyrir tíma.',
  },
  app_tilkynningar: {
    label: 'Snjallsímaapp',
    description: 'Tilkynningar um nýjar bókanir í appið (iOS og Android).',
  },
};

export type BookingStatus = 'beidni' | 'stadfest' | 'maett' | 'lokid' | 'afbokad' | 'ekki_maett';
export type BookingSource = 'vefur' | 'simi' | 'stjornbord' | 'app' | 'sms';

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  beidni: 'Beiðni',
  stadfest: 'Staðfest',
  maett: 'Mætt',
  lokid: 'Lokið',
  afbokad: 'Afbókað',
  ekki_maett: 'Mætti ekki',
};

export const BOOKING_SOURCE_LABELS: Record<BookingSource, string> = {
  vefur: 'Vefsíða',
  simi: 'Sími',
  stjornbord: 'Stjórnborð',
  app: 'App',
  sms: 'SMS',
};

/** Statuses that still occupy time in the diary. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = ['beidni', 'stadfest', 'maett', 'lokid'];

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  legalName: string;
  kennitala: string | null;
  industry: string;
  tagline: string;
  about: string;
  email: string;
  phone: string;
  websiteDomain: string;
  address: string;
  postcode: string;
  city: string;
  timezone: string;
  locale: string;
  currency: string;
  brandColor: string;
  accentColor: string;
  logoUrl: string;
  slotGranularityMin: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
  cancelWindowHours: number;
  respectHolidays: boolean;
  autoConfirm: boolean;
  greeting: string;
  forwardNumber: string;
  voicemailEmail: string;
  status: TenantStatus;
  plan: string;
  notes: string;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface Service {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  priceIsk: number;
  vskRate: number;
  capacity: number;
  requiresStaff: boolean;
  isPublic: boolean;
  active: boolean;
  sortOrder: number;
  color: string;
}

export interface Staff {
  id: string;
  tenantId: string;
  name: string;
  title: string;
  email: string;
  phone: string;
  color: string;
  acceptsBookings: boolean;
  googleCalendarId: string;
  active: boolean;
  sortOrder: number;
}

export interface OpeningHours {
  id: string;
  tenantId: string;
  staffId: string | null;
  weekday: Weekday;
  openMin: MinuteOfDay;
  closeMin: MinuteOfDay;
}

export interface ScheduleException {
  id: string;
  tenantId: string;
  staffId: string | null;
  date: PlainDate;
  closed: boolean;
  openMin: MinuteOfDay | null;
  closeMin: MinuteOfDay | null;
  note: string;
}

export interface Customer {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  phone: string;
  kennitala: string | null;
  notes: string;
  marketingConsent: boolean;
  noShowCount: number;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface Booking {
  id: string;
  tenantId: string;
  serviceId: string;
  staffId: string | null;
  customerId: string;
  startsAt: Instant;
  endsAt: Instant;
  blockStartAt: Instant;
  blockEndAt: Instant;
  status: BookingStatus;
  source: BookingSource;
  priceIsk: number;
  notes: string;
  internalNotes: string;
  cancelToken: string;
  googleEventId: string;
  googleCalendarId: string;
  reminderSentAt: Instant | null;
  confirmationSentAt: Instant | null;
  cancelledAt: Instant | null;
  cancelReason: string;
  createdAt: Instant;
  updatedAt: Instant;
}

/** A booking joined with the names needed to display it. */
export interface BookingView extends Booking {
  serviceName: string;
  staffName: string | null;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  tenantName: string;
  tenantTimezone: string;
}

export interface AvailableSlot {
  /** Start of the appointment as shown to the customer. */
  startsAt: Instant;
  endsAt: Instant;
  staffId: string | null;
  staffName: string | null;
}

export interface DayAvailability {
  date: PlainDate;
  /** Empty when closed; `closedReason` explains why. */
  slots: AvailableSlot[];
  closed: boolean;
  closedReason: string | null;
}
