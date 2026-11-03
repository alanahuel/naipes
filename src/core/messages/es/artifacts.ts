/** Las tarjetas dentro de una lección: investigaciones, demos, visuales, herramientas. */
export default {
	"artifacts.failed": "falló",
	"artifacts.invertColors": "Invertir los colores",

	// Lo que se lanza en segundo plano (tarjeta de envío)
	"artifacts.dispatch.kindResearch": "Investigación",
	"artifacts.dispatch.kindDemo": "Demo",
	"artifacts.dispatch.kindVisual": "Figura",
	"artifacts.dispatch.kindPdf": "Lectura de PDF",
	"artifacts.dispatch.running": "{label} en marcha",
	"artifacts.dispatch.pending": "En camino…",
	"artifacts.dispatch.finished": "terminada",
	"artifacts.dispatch.failed": "falló",
	"artifacts.dispatch.needsModels": "falta configurar los modelos",
	"artifacts.dispatch.setUpModels": "Configurar los modelos…",
	"artifacts.dispatch.needsKey": "falta una clave de proveedor",
	"artifacts.dispatch.addKey": "Añadir una clave…",

	// Lo que entrega cada tarea al terminar
	"artifacts.steer.unreadable": "Una tarea en segundo plano terminó, pero no pude mostrar su resultado.",
	"artifacts.steer.aborted": "la paraste tú",
	"artifacts.steer.kindResearch": "investigación",
	"artifacts.steer.kindDemo": "demo",
	"artifacts.steer.kindVisual": "figura",
	"artifacts.steer.kindPdf": "PDF",
	"artifacts.steer.kindJob": "tarea",
	"artifacts.steer.viewBrief": "ver el informe",
	"artifacts.steer.hideBrief": "ocultar el informe",

	// Investigación
	"artifacts.research.label": "Investigación",
	"artifacts.research.complete": "terminada",
	"artifacts.research.sourceCount": { one: "· {n} fuente", other: "· {n} fuentes" },
	"artifacts.research.brief": "Informe de la investigación",
	"artifacts.research.sources": "Fuentes",
	"artifacts.research.unreadable": "La investigación terminó, pero no pude mostrar el resultado.",

	// PDF
	"artifacts.pdf.complete": "lectura terminada",
	"artifacts.pdf.pagesReadCount": { one: "· {n} página leída", other: "· {n} páginas leídas" },
	"artifacts.pdf.brief": "Informe del PDF",
	"artifacts.pdf.pagesRead": "Páginas leídas: {pages}",
	"artifacts.pdf.pagesConsulted": "Páginas consultadas: {pages}",
	"artifacts.pdf.unreadable": "La lectura del PDF terminó, pero no pude mostrar el resultado.",

	// Demos interactivas
	"artifacts.demo.label": "Demo interactiva",
	"artifacts.demo.caption": "Demo interactiva",
	"artifacts.demo.unreadable": "La demo terminó, pero no pude mostrarla.",
	"artifacts.demo.notBuilt": "Tu tutor no pudo construir la demo.",
	"artifacts.demo.invert": "Invertir el brillo de la demo",
	"artifacts.demo.downloadAria": "Descargar la demo como HTML",
	"artifacts.demo.download": "Descargar como HTML",
	"artifacts.demo.errorTitle": "La demo dio un error",
	"artifacts.demo.sendToTutor": "Contárselo a tu tutor",

	// Figuras
	"artifacts.visual.figure": "Figura",
	"artifacts.visual.unreadable": "La figura terminó, pero no pude mostrarla.",
	"artifacts.visual.notDrawn": "Tu tutor no pudo dibujar la figura.",
	"artifacts.visual.invert": "Invertir el brillo de la figura",
	"artifacts.visual.downloadAria": "Descargar la figura como SVG",
	"artifacts.visual.download": "Descargar como SVG",
	"artifacts.visual.fullscreenAria": "Ver la figura a pantalla completa",
	"artifacts.visual.fullscreen": "Pantalla completa",

	// Herramientas (leer archivos, buscar…)
	"artifacts.tool.live": "{label} · en curso",
	"artifacts.tool.inputStreaming": "Entrada (llegando)",
	"artifacts.tool.input": "Entrada",
	"artifacts.tool.output": "Resultado",
	"artifacts.tool.error": "Error",
	"artifacts.tool.running": "En marcha…",
	"artifacts.tool.imagesAttached": { one: "[{n} imagen enviada al modelo]", other: "[{n} imágenes enviadas al modelo]" },

	// El cierre del diagnóstico
	"artifacts.probe.title": "Diagnóstico terminado: así ve tu tutor lo que sabes",
	"artifacts.probe.retried": "Tu tutor lo intentó otra vez: {error}",
	"artifacts.probe.malformed": "La evaluación salió con un formato incorrecto; tu tutor la rehízo.",
	"artifacts.probe.writing": "Escribiendo la evaluación…",
} as const;
