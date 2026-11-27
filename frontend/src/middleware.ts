import { defineMiddleware } from 'astro:middleware';

export const onRequest = defineMiddleware(async (context, next) => {
	if (/^\/s\/[^/]+\/?$/.test(context.url.pathname)) return context.rewrite('/s');
	return next();
});
