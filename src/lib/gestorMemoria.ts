// gestorMemoria.ts
// Modulo de gestion de memoria columnar y pool de workers (RF-1, RF-2, RT-1, RT-2)
// Estilo: codigo directo, variables directas, comentarios de estudiante

export interface PresupuestoMemoria {
  bytesPorRegistro: number;
  totalBytes20M: number;
  totalMb20M: number;
  comparadoJsObjetosMb: number;
}

export class GestorMemoria {
  maxFilas: number;
  sabMedidores: SharedArrayBuffer | null = null;
  sabHoras: SharedArrayBuffer | null = null;
  sabKwh: SharedArrayBuffer | null = null;
  sabFlags: SharedArrayBuffer | null = null;
  sabVersiones: SharedArrayBuffer | null = null;
  sabContadorGlobal: SharedArrayBuffer | null = null;

  arrMedidores: Uint32Array | null = null;
  arrHoras: Uint16Array | null = null;
  arrKwh: Float32Array | null = null;
  arrFlags: Uint8Array | null = null;
  arrVersiones: Uint8Array | null = null;
  arrContador: Int32Array | null = null;

  constructor(maxFilas: number = 4000000) {
    // Por defecto 4M de filas de capacidad (o escalable hasta 20M)
    this.maxFilas = maxFilas;
  }

  // Calculo de memoria columnar vs objetos JS (Exigencia RF-2)
  calcularPresupuesto(): PresupuestoMemoria {
    // Columnas:
    // meter_idx (Uint32) = 4 bytes
    // ts_hour (Uint16) = 2 bytes
    // kwh (Float32) = 4 bytes
    // flags (Uint8) = 1 byte
    // version (Uint8) = 1 byte
    // TOTAL POR FILA = 12 bytes
    const bytesFila = 12;
    const total20M = 20000000 * bytesFila;
    const totalMb = total20M / (1024 * 1024);
    // Un objeto JS ordinario {meter_id: "...", ts: 123, kwh: 0.4, ...} cuesta aprox 120-160 bytes en V8
    const objetosJsMb = (20000000 * 140) / (1024 * 1024);

    return {
      bytesPorRegistro: bytesFila,
      totalBytes20M: total20M,
      totalMb20M: parseFloat(totalMb.toFixed(2)),
      comparadoJsObjetosMb: parseFloat(objetosJsMb.toFixed(2))
    };
  }

  inicializarBuffers(): boolean {
    try {
      if (typeof SharedArrayBuffer === 'undefined') {
        console.error("SharedArrayBuffer no esta soportado o falta crossOriginIsolated!");
        return false;
      }

      console.log("Reservando memoria SharedArrayBuffer para " + this.maxFilas + " filas...");
      this.sabMedidores = new SharedArrayBuffer(this.maxFilas * 4);
      this.sabHoras = new SharedArrayBuffer(this.maxFilas * 2);
      this.sabKwh = new SharedArrayBuffer(this.maxFilas * 4);
      this.sabFlags = new SharedArrayBuffer(this.maxFilas * 1);
      this.sabVersiones = new SharedArrayBuffer(this.maxFilas * 1);
      this.sabContadorGlobal = new SharedArrayBuffer(4); // 1 entero para Atomics

      this.arrMedidores = new Uint32Array(this.sabMedidores);
      this.arrHoras = new Uint16Array(this.sabHoras);
      this.arrKwh = new Float32Array(this.sabKwh);
      this.arrFlags = new Uint8Array(this.sabFlags);
      this.arrVersiones = new Uint8Array(this.sabVersiones);
      this.arrContador = new Int32Array(this.sabContadorGlobal);
      
      Atomics.store(this.arrContador, 0, 0); // resetear contador
      console.log("Memoria reservada con exito!");
      return true;
    } catch (err) {
      console.error("Error al inicializar SharedArrayBuffer:", err);
      return false;
    }
  }

  async procesarArchivoConWorkers(
    archivo: File, 
    tamanoBloqueMb: number = 8,
    onProgreso: (porcentaje: number, filas: number) => void
  ): Promise<number> {
    if (!this.sabMedidores || !this.arrContador) {
      this.inicializarBuffers();
    }

    const t0 = performance.now();
    const numWorkers = navigator.hardwareConcurrency || 4;
    console.log("Creando pool de " + numWorkers + " Web Workers (RT-1)...");

    const workers: Worker[] = [];
    for (let i = 0; i < numWorkers; i++) {
      workers.push(new Worker('/workers/lector_worker.js'));
    }

    const tamanoBloqueBytes = tamanoBloqueMb * 1024 * 1024;
    const totalBytes = archivo.size;
    const totalBloques = Math.ceil(totalBytes / tamanoBloqueBytes);
    console.log("Archivo: " + archivo.name + " (" + (totalBytes / (1024*1024)).toFixed(2) + " MB), en " + totalBloques + " bloques");

    let bloqueActual = 0;
    let bloquesTerminados = 0;
    const tsInicio = 1767225600;

    return new Promise((resolve, reject) => {
      const asignarSiguienteBloque = (worker: Worker) => {
        if (bloqueActual >= totalBloques) {
          return; // no hay mas bloques
        }

        const idx = bloqueActual++;
        const start = idx * tamanoBloqueBytes;
        // Leemos un poquito mas al final para no cortar lineas (512 bytes extra de margen)
        const end = Math.min(totalBytes, start + tamanoBloqueBytes + 512);
        const sliceBlob = archivo.slice(start, end);

        const reader = new FileReader();
        reader.onload = () => {
          const buffer = reader.result as ArrayBuffer;
          worker.postMessage({
            tipo: 'PROCESAR_BLOQUE',
            data: {
              bloqueIndex: idx,
              bufferChunk: buffer,
              inicioByte: start,
              esPrimerBloque: idx === 0,
              tsInicioMes: tsInicio,
              sabMedidores: this.sabMedidores,
              sabHoras: this.sabHoras,
              sabKwh: this.sabKwh,
              sabFlags: this.sabFlags,
              sabVersiones: this.sabVersiones,
              sabContadorGlobal: this.sabContadorGlobal
            }
          });
        };
        reader.onerror = (e) => console.error("Error leyendo chunk " + idx, e);
        reader.readAsArrayBuffer(sliceBlob);
      };

      workers.forEach((worker, wId) => {
        worker.onmessage = (e) => {
          const { tipo, bloqueIndex, filas, tiempoMs } = e.data;
          if (tipo === 'BLOQUE_COMPLETADO') {
            bloquesTerminados++;
            const filasActuales = Atomics.load(this.arrContador!, 0);
            const pct = Math.min(100, Math.round((bloquesTerminados / totalBloques) * 100));
            onProgreso(pct, filasActuales);

            if (bloquesTerminados >= totalBloques) {
              // Terminaron todos
              const tiempoTotal = performance.now() - t0;
              console.log("Procesamiento terminado en " + tiempoTotal.toFixed(0) + " ms. Filas totales: " + filasActuales);
              // Limpiar workers
              workers.forEach(w => w.terminate());
              resolve(filasActuales);
            } else {
              // Asignar siguiente bloque al worker libre
              asignarSiguienteBloque(worker);
            }
          }
        };

        // Asignar primer bloque
        asignarSiguienteBloque(worker);
      });
    });
  }
}
