// @ts-check
import { defineConfig } from 'astro/config';

const intakeDevRewrite = {
	name: 'lanoche-intake-token-route',
	configureServer(server) {
		server.middlewares.use((request, _response, next) => {
			if (request.url) {
				const url = new URL(request.url, 'http://localhost');
				if (/^\/s\/[^/]+\/?$/.test(url.pathname)) request.url = `/s/index.html${url.search}`;
			}
			next();
		});
	},
};

// https://astro.build/config
export default defineConfig({
	site: 'https://lanocheps.proysocial.org',
	vite: { plugins: [intakeDevRewrite] },
});
