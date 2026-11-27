export const botMessages = {
  help: '¡Hola! Para participar, envía un sticker animado o abre la página de postulaciones: {{web_url}}',
  closed: 'Las postulaciones de la Gala ya cerraron. ¡Gracias por participar!',
  dailyLimit: 'Ya alcanzaste el límite diario de stickers. Inténtalo más adelante.',
  error: 'No pudimos procesar tu sticker. Inténtalo de nuevo más tarde.',
  link: (url: string) => `¡Tu sticker está listo! Completa tu postulación aquí: ${url}`,
};
