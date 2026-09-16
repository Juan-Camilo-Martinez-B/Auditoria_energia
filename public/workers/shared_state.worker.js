// shared_state.worker.js
// SharedWorker para compartir estado y resultados entre varias pestañas (RT-5, RF-8)
// Hecho para que el profesor abra 3 pestañas y no re-procese el archivo

const puertosConectados = [];
let estadoAnalisis = {
  listo: false,
  totalFilas: 0,
  rankingTop200: [],
  porcentajeImputados: 0,
  fechaProcesamiento: null
};

self.onconnect = function(e) {
  const port = e.ports[0];
  puertosConectados.push(port);
  console.log("Nueva pestaña conectada al SharedWorker. Total pestañas: " + puertosConectados.length);

  port.onmessage = function(event) {
    const { tipo, payload } = event.data;

    if (tipo === 'CONSULTAR_ESTADO') {
      // Devolver el estado actual a la pestaña que pregunta
      port.postMessage({
        tipo: 'ESTADO_ACTUAL',
        estado: estadoAnalisis
      });
    }

    if (tipo === 'GUARDAR_RESULTADOS') {
      console.log("Guardando nuevos resultados en SharedWorker...");
      estadoAnalisis = {
        listo: true,
        totalFilas: payload.totalFilas,
        rankingTop200: payload.rankingTop200,
        porcentajeImputados: payload.porcentajeImputados,
        fechaProcesamiento: new Date().toISOString()
      };

      // Difundir (broadcast) a todas las pestañas abiertas
      puertosConectados.forEach(p => {
        try {
          p.postMessage({
            tipo: 'ESTADO_ACTUAL',
            estado: estadoAnalisis
          });
        } catch (err) {
          console.warn("Error enviando estado a pestaña:", err);
        }
      });
    }

    if (tipo === 'RESET_ESTADO') {
      estadoAnalisis = {
        listo: false,
        totalFilas: 0,
        rankingTop200: [],
        porcentajeImputados: 0,
        fechaProcesamiento: null
      };
      puertosConectados.forEach(p => {
        try {
          p.postMessage({ tipo: 'ESTADO_ACTUAL', estado: estadoAnalisis });
        } catch (err) {}
      });
    }
  };

  // Enviar estado inmediato al conectarse
  port.postMessage({
    tipo: 'ESTADO_ACTUAL',
    estado: estadoAnalisis
  });

  port.start();
};
