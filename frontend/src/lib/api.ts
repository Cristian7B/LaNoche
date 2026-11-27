export type EventStatus = 'open' | 'closed' | 'results_published';

export interface GalaEvent {
  status: EventStatus;
  effective_status: EventStatus;
  closes_at: string | null;
  server_time: string;
  limits: {
    max_votes_per_category: number;
    max_photo_submissions: number;
    max_sticker_submissions: number;
    max_images_per_photo: number;
  };
  bot_wa_link: string | null;
}

export interface CurrentUser {
  id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: 'participant' | 'admin';
  human_verified: boolean;
  usage: {
    submissions: { photo: number; sticker: number };
    votes: { photo: number; sticker: number };
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const baseUrl = (import.meta.env.PUBLIC_API_BASE_URL ?? '').replace(/\/$/, '');

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { accessToken?: string } = {},
): Promise<T> {
  const { accessToken, headers, ...requestOptions } = options;
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'application/json');
  if (requestOptions.body instanceof FormData) requestHeaders.delete('Content-Type');
  else if (requestOptions.body !== undefined && !requestHeaders.has('Content-Type')) {
    requestHeaders.set('Content-Type', 'application/json');
  }
  if (accessToken) requestHeaders.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    ...requestOptions,
    headers: requestHeaders,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const error = payload?.error;
    throw new ApiError(
      error?.message ?? `La solicitud no pudo completarse (${response.status}).`,
      response.status,
      error?.code,
      error?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const getEvent = () => apiRequest<GalaEvent>('/event');
export const getMe = (accessToken: string) => apiRequest<CurrentUser>('/me', { accessToken });
