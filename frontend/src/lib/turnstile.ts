type TurnstileApi = {
	render: (element: HTMLElement, options: { sitekey: string; callback: (token: string) => void; 'expired-callback'?: () => void; 'error-callback'?: () => void }) => string;
	remove: (widgetId: string) => void;
	reset?: (widgetId: string) => void;
};

declare global { interface Window { turnstile?: TurnstileApi } }

let scriptPromise: Promise<void> | undefined;

async function loadTurnstile() {
	if (window.turnstile) return;
	scriptPromise ??= new Promise((resolve, reject) => {
		const existing = document.querySelector<HTMLScriptElement>('script[data-turnstile]');
		if (existing) { existing.addEventListener('load', () => resolve(), { once: true }); existing.addEventListener('error', () => reject(new Error('No se pudo cargar la verificación.')), { once: true }); return; }
		const script = document.createElement('script');
		script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		script.async = true; script.defer = true; script.dataset.turnstile = 'true';
		script.onload = () => resolve(); script.onerror = () => reject(new Error('No se pudo cargar la verificación.'));
		document.head.append(script);
	});
	await scriptPromise;
}

export async function mountTurnstile(container: HTMLElement, onToken: (token: string) => void) {
	const sitekey = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY;
	if (!sitekey) throw new Error('Falta configurar la verificación humana.');
	await loadTurnstile();
	if (!window.turnstile) throw new Error('La verificación no está disponible.');
	return window.turnstile.render(container, {
		sitekey,
		callback: onToken,
		'expired-callback': () => onToken(''),
		'error-callback': () => onToken(''),
	});
}

export function resetTurnstile(widgetId?: string) {
	if (widgetId) window.turnstile?.reset?.(widgetId);
}

export function destroyTurnstile(widgetId?: string) {
	if (widgetId) window.turnstile?.remove(widgetId);
}
