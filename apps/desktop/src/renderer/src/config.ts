/** 백엔드 주소 (apps/desktop/.env 의 VITE_API_BASE_URL, 기본 http://localhost:3000) */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

/** 백엔드 COMPLAINT_MAX_CHARS 기본값과 맞춘다(초과하면 백엔드도 400을 준다) */
export const COMPLAINT_MAX_CHARS = 5000;
