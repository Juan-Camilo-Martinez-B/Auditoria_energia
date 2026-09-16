// lector_worker.js
// Web Worker para leer bloques de CSV en paralelo
// Tarea de Auditoria de Energia - 7mo Semestre
// Nota: no tocar el ciclo for de corte de lineas porque se duplican las filas xd

self.onmessage = function(e) {
  const { tipo, data } = e.data;

  if (tipo === 'PROCESAR_BLOQUE') {
    const { 
      bloqueIndex, 
      bufferChunk, 
      inicioByte, 
      esPrimerBloque, 
      tsInicioMes,
      // Buffers compartidos (SharedArrayBuffer)
      sabMedidores, 
      sabHoras, 
      sabKwh, 
      sabFlags, 
      sabVersiones,
      sabContadorGlobal
    } = data;

    const t0 = performance.now();
    // console.log("Worker procesando bloque #" + bloqueIndex + " desde byte " + inicioByte);

    // Vistas de arreglos tipados sobre la memoria compartida
    const arrMedidores = new Uint32Array(sabMedidores);
    const arrHoras = new Uint16Array(sabHoras);
    const arrKwh = new Float32Array(sabKwh);
    const arrFlags = new Uint8Array(sabFlags);
    const arrVersiones = new Uint8Array(sabVersiones);
    const arrContador = new Int32Array(sabContadorGlobal);

    // Decodificar el bloque a texto
    const decoder = new TextDecoder('utf-8');
    const texto = decoder.decode(bufferChunk);

    let offset = 0;
    // Si NO es el primer bloque, debemos saltar la primera linea incompleta
    // porque el bloque anterior la termino de leer
    if (!esPrimerBloque) {
      const primerSalto = texto.indexOf('\n');
      if (primerSalto === -1) {
        // Bloque muy chiquito o raro
        self.postMessage({ tipo: 'BLOQUE_COMPLETADO', bloqueIndex, filas: 0, tiempoMs: performance.now() - t0 });
        return;
      }
      offset = primerSalto + 1;
    } else {
      // Si es el primer bloque y trae encabezado (meter_id,ts,...), saltarlo
      if (texto.startsWith('meter_id') || texto.startsWith('nodo_id')) {
        const saltoEncabezado = texto.indexOf('\n');
        if (saltoEncabezado !== -1) {
          offset = saltoEncabezado + 1;
        }
      }
    }

    let filasProcesadas = 0;
    const len = texto.length;

    // Procesar linea por linea
    while (offset < len) {
      let finLinea = texto.indexOf('\n', offset);
      if (finLinea === -1) {
        // Llegamos al final del bloque.
        // Si no termina en \n, esta linea incompleta la procesara el siguiente bloque
        break;
      }

      let linea = texto.substring(offset, finLinea).trim();
      offset = finLinea + 1;

      if (linea.length === 0) continue;

      // Parseo manual rapido por comas: meter_id,ts,kwh,version,flags
      const partes = linea.split(',');
      if (partes.length < 5) continue;

      const meterHex = partes[0].trim();
      const ts = parseInt(partes[1]);
      const kwhStr = partes[2].trim();
      const version = parseInt(partes[3]) || 1;
      const flags = parseInt(partes[4]) || 0;

      // Convertir meterHex a id entero denso (hash basico de 32 bits a entero)
      // Como los medidores son MTR000000001 o A1F20C39D4B8, convertimos a entero
      let meterIdNum = 0;
      if (meterHex.startsWith('MTR')) {
        meterIdNum = parseInt(meterHex.replace('MTR', ''), 16) || 0;
      } else {
        // Hash rapido djb2 mod 500000
        let hash = 5381;
        for (let c = 0; c < meterHex.length; c++) {
          hash = ((hash << 5) + hash) + meterHex.charCodeAt(c);
          hash = hash & hash;
        }
        meterIdNum = Math.abs(hash) % 500000;
      }

      // Calcular hora offset (0 a 719)
      let horaOffset = 0;
      if (!isNaN(ts) && ts >= tsInicioMes) {
        horaOffset = Math.floor((ts - tsInicioMes) / 3600);
        if (horaOffset < 0) horaOffset = 0;
        if (horaOffset > 719) horaOffset = 719;
      }

      let kwhVal = kwhStr === '' ? -999.0 : parseFloat(kwhStr); // -999 indica hueco de lectura

      // Reservar posicion atomica en el buffer compartido
      const pos = Atomics.add(arrContador, 0, 1);

      if (pos < arrMedidores.length) {
        arrMedidores[pos] = meterIdNum;
        arrHoras[pos] = horaOffset;
        arrKwh[pos] = kwhVal;
        arrFlags[pos] = flags;
        arrVersiones[pos] = version;
        filasProcesadas++;
      } else {
        // Overflow de memoria compartida
        console.warn("SharedArrayBuffer lleno! pos=" + pos);
        break;
      }
    }

    const tTotal = performance.now() - t0;
    self.postMessage({
      tipo: 'BLOQUE_COMPLETADO',
      bloqueIndex: bloqueIndex,
      filas: filasProcesadas,
      tiempoMs: tTotal
    });
  }
};
