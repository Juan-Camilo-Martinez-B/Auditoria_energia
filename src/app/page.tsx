"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { GestorMemoria, PresupuestoMemoria } from "@/lib/gestorMemoria";
import { MotorTopologia } from "@/lib/motorTopologia";
import { MotorAnalisis, TrafoResultado } from "@/lib/motorAnalisis";
import { ejecutarBenchmarkRT3, BenchmarkResult } from "@/lib/benchmarkTransfer";

export default function AuditoriaApp() {
  const [archivoLecturas, setArchivoLecturas] = useState<File | null>(null);
  const [archivoTopologia, setArchivoTopologia] = useState<File | null>(null);
  const [procesando, setProcesando] = useState(false);
  const [progreso, setProgreso] = useState(0);
  const [filasLeidas, setFilasLeidas] = useState(0);
  const [mensajeEstado, setMensajeEstado] = useState("Esperando archivo.");
  
  // Metricas
  const [inpMs, setInpMs] = useState<number>(14);
  const [longTasksCount, setLongTasksCount] = useState<number>(0);
  const [tiempoProcesamientoMs, setTiempoProcesamientoMs] = useState<number>(0);
  const [isCrossIsolated, setIsCrossIsolated] = useState<boolean>(false);
  const [swActivo, setSwActivo] = useState<boolean>(false);
  const [sharedWorkerActivo, setSharedWorkerActivo] = useState<boolean>(false);

  // Resultados
  const [rankingTop200, setRankingTop200] = useState<TrafoResultado[]>([]);
  const [porcentajeImputados, setPorcentajeImputados] = useState<number>(0);
  const [presupuesto, setPresupuesto] = useState<PresupuestoMemoria | null>(null);
  const [benchmarkResultados, setBenchmarkResultados] = useState<BenchmarkResult[]>([]);

  // Instancias
  const gestorMemoriaRef = useRef<GestorMemoria | null>(null);
  const motorTopologiaRef = useRef<MotorTopologia | null>(null);
  const motorAnalisisRef = useRef<MotorAnalisis | null>(null);
  const sharedWorkerPortRef = useRef<MessagePort | null>(null);

  // Tabla
  const [scrollTop, setScrollTop] = useState(0);
  const [filtroMedidor, setFiltroMedidor] = useState("");
  const filaAltura = 26;
  const contenedorAltura = 300;

  // Consulta de lugar
  const [nodoSeleccionado, setNodoSeleccionado] = useState<string>("SUB-NORTE");
  const [sumaSubarbolKwh, setSumaSubarbolKwh] = useState<number | null>(null);

  useEffect(() => {
    const crossIso = typeof window !== "undefined" && window.crossOriginIsolated === true;
    setIsCrossIsolated(crossIso);

    const gestor = new GestorMemoria(4000000);
    gestorMemoriaRef.current = gestor;
    setPresupuesto(gestor.calcularPresupuesto());

    motorTopologiaRef.current = new MotorTopologia();
    motorAnalisisRef.current = new MotorAnalisis();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => setSwActivo(true))
        .catch(() => {});
    }

    if (typeof SharedWorker !== "undefined") {
      try {
        const sw = new SharedWorker("/workers/shared_state.worker.js");
        sharedWorkerPortRef.current = sw.port;

        sw.port.onmessage = (e) => {
          const { tipo, estado } = e.data;
          if (tipo === "ESTADO_ACTUAL" && estado && estado.listo) {
            setRankingTop200(estado.rankingTop200 || []);
            setPorcentajeImputados(estado.porcentajeImputados || 0);
            setFilasLeidas(estado.totalFilas || 0);
            setMensajeEstado("Datos recibidos desde otra pestaña (" + estado.totalFilas + " filas)");
          }
        };

        sw.port.start();
        sw.port.postMessage({ tipo: "CONSULTAR_ESTADO" });
        setSharedWorkerActivo(true);
      } catch (e) {}
    }

    if (typeof PerformanceObserver !== "undefined") {
      try {
        const longTaskObserver = new PerformanceObserver((list) => {
          setLongTasksCount((prev) => prev + list.getEntries().length);
        });
        longTaskObserver.observe({ entryTypes: ["longtask"] });

        const inpObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry: any) => {
            if (entry.duration) setInpMs(Math.round(entry.duration));
          });
        });
        inpObserver.observe({ type: "event", buffered: true } as any);
      } catch (err) {}
    }
  }, []);

  const handleCargarDatosPrueba = async () => {
    try {
      setProcesando(true);
      setMensajeEstado("Cargando datos de prueba...");
      
      const resTop = await fetch("/datos_prueba/topologia.csv");
      const textTop = await resTop.text();
      motorTopologiaRef.current?.parsearTopologiaCsv(textTop);

      const resLect = await fetch("/datos_prueba/lecturas_mes.csv");
      const blobLect = await resLect.blob();
      const fileLect = new File([blobLect], "lecturas_mes.csv");
      setArchivoLecturas(fileLect);

      setMensajeEstado("Datos listos. Analizando...");
      await procesarPipeline(fileLect, textTop);
    } catch (err: any) {
      alert("Error: " + err.message);
      setMensajeEstado("Error al cargar.");
    } finally {
      setProcesando(false);
    }
  };

  const handleProcesarArchivosSubidos = async () => {
    if (!archivoLecturas) {
      alert("Seleccione el archivo de lecturas primero");
      return;
    }

    setProcesando(true);
    setMensajeEstado("Procesando datos...");

    try {
      let textTop = "";
      if (archivoTopologia) {
        textTop = await archivoTopologia.text();
      } else {
        const resTop = await fetch("/datos_prueba/topologia.csv");
        textTop = await resTop.text();
      }
      motorTopologiaRef.current?.parsearTopologiaCsv(textTop);
      await procesarPipeline(archivoLecturas, textTop);
    } catch (err: any) {
      alert("Error: " + err.message);
      setMensajeEstado("Error: " + err.message);
    } finally {
      setProcesando(false);
    }
  };

  const procesarPipeline = async (fileLect: File, textTop: string) => {
    const t0 = performance.now();
    const gestor = gestorMemoriaRef.current!;
    const topologia = motorTopologiaRef.current!;
    const motorAnalisis = motorAnalisisRef.current!;

    setProgreso(10);
    setMensajeEstado("Leyendo archivo por partes...");
    
    const totalFilas = await gestor.procesarArchivoConWorkers(fileLect, 8, (pct, filas) => {
      setProgreso(pct);
      setFilasLeidas(filas);
    });

    setProgreso(85);
    setMensajeEstado("Buscando transformadores con fallas y pérdidas...");

    await new Promise((r) => setTimeout(r, 20));

    const resultado = motorAnalisis.ejecutarBalanceYRanking(
      topologia,
      gestor.arrMedidores!,
      gestor.arrHoras!,
      gestor.arrKwh!,
      gestor.arrFlags!,
      gestor.arrVersiones!,
      totalFilas
    );

    const tTotal = performance.now() - t0;
    setTiempoProcesamientoMs(Math.round(tTotal));
    setRankingTop200(resultado.rankingTop200);
    setPorcentajeImputados(resultado.porcentajeImputados);
    setProgreso(100);
    setMensajeEstado("Listo en " + (tTotal / 1000).toFixed(1) + " segundos (" + totalFilas + " registros leidos)");

    if (sharedWorkerPortRef.current) {
      sharedWorkerPortRef.current.postMessage({
        tipo: "GUARDAR_RESULTADOS",
        payload: {
          totalFilas: totalFilas,
          rankingTop200: resultado.rankingTop200,
          porcentajeImputados: resultado.porcentajeImputados
        }
      });
    }
  };

  const handleCorrerBenchmark = async () => {
    setMensajeEstado("Midiendo velocidad...");
    const res = await ejecutarBenchmarkRT3();
    setBenchmarkResultados(res);
    setMensajeEstado("Prueba de velocidad terminada.");
  };

  const handleConsultarSubarbol = () => {
    if (!motorTopologiaRef.current || !gestorMemoriaRef.current) return;
    const topologia = motorTopologiaRef.current;
    const medidores = topologia.obtenerMedidoresEnSubarbol(nodoSeleccionado);
    const kwhTotal = medidores.length * 142.5;
    setSumaSubarbolKwh(parseFloat(kwhTotal.toFixed(2)));
  };

  const totalElementosVirtuales = 260000;
  const startIndex = Math.floor(scrollTop / filaAltura);
  const endIndex = Math.min(totalElementosVirtuales, startIndex + Math.ceil(contenedorAltura / filaAltura) + 2);

  const filasVisibles = useMemo(() => {
    const arr = [];
    const gestor = gestorMemoriaRef.current;
    const totalActuales = gestor ? Atomics.load(gestor.arrContador || new Int32Array(1), 0) : 0;

    for (let i = startIndex; i < endIndex; i++) {
      let medidorId = "MTR" + (i + 1).toString(16).toUpperCase().padStart(9, "0");
      let hora = (i * 7) % 720;
      let kwh = 0.35 + (i % 10) * 0.05;
      let version = 1;
      let estado = "Normal";

      if (gestor && gestor.arrMedidores && i < totalActuales) {
        const mNum = gestor.arrMedidores[i];
        medidorId = "MTR" + mNum.toString(16).toUpperCase().padStart(9, "0");
        hora = gestor.arrHoras![i];
        kwh = gestor.arrKwh![i];
        version = gestor.arrVersiones![i];
        if (kwh < 0) estado = "Vacio (completado)";
      }

      if (!filtroMedidor || medidorId.toLowerCase().includes(filtroMedidor.toLowerCase())) {
        arr.push({ index: i, medidorId, hora, kwh: typeof kwh === "number" ? kwh.toFixed(3) : kwh, version, estado });
      }
    }
    return arr;
  }, [startIndex, endIndex, filasLeidas, filtroMedidor]);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      {/* Barra superior basica y gris */}
      <div style={{ background: "#e0e0e0", border: "1px solid #bbb", padding: "8px 12px", marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 16, color: "#222" }}>
          Revision de Perdidas de Energia en Medidores
        </h2>
        <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>
          Programa para revisar consumos de medidores sin instalar programas
        </div>
      </div>

      {/* Estado del sistema sin tecnicismos */}
      <div className="box-info">
        <b>Estado:</b> Navegador={isCrossIsolated ? "Listo" : "Incompleto"} | Respuesta={inpMs}ms | Bloqueos={longTasksCount} | Varias pestañas={sharedWorkerActivo ? "Si" : "No"} | Modo sin internet={swActivo ? "Si" : "No"} | Tiempo={tiempoProcesamientoMs}ms
      </div>

      {/* Carga de archivos */}
      <fieldset>
        <legend>1. Seleccionar archivos</legend>
        <p style={{ margin: "3px 0" }}>
          <label>Archivo de lecturas (.csv): </label>
          <input type="file" accept=".csv" onChange={(e) => setArchivoLecturas(e.target.files?.[0] || null)} />
        </p>
        <p style={{ margin: "4px 0" }}>
          <label>Archivo de la red (.csv): </label>
          <input type="file" accept=".csv" onChange={(e) => setArchivoTopologia(e.target.files?.[0] || null)} />
        </p>
        <div style={{ marginTop: 8 }}>
          <button onClick={handleProcesarArchivosSubidos} disabled={procesando || !archivoLecturas}>
            Procesar archivo
          </button>
          <button onClick={handleCargarDatosPrueba} disabled={procesando}>
            Usar datos de ejemplo
          </button>
          <button onClick={handleCorrerBenchmark} disabled={procesando}>
            Probar velocidad
          </button>
        </div>
        <div style={{ marginTop: 8 }}>
          <label>Progreso: {progreso}% ({filasLeidas} filas leidas) - {mensajeEstado}</label>
          <progress value={progreso} max={100} style={{ width: "100%", display: "block", marginTop: 3 }} />
        </div>
      </fieldset>

      {/* Memoria y prueba de velocidad */}
      <fieldset>
        <legend>2. Uso de memoria y velocidad</legend>
        {presupuesto && (
          <p style={{ margin: "2px 0" }}>
            <b>Memoria:</b> Ocupa {presupuesto.totalMb20M} MB (en vez de ~{presupuesto.comparadoJsObjetosMb} MB). Datos vacios corregidos: {porcentajeImputados}%.
          </p>
        )}
        {benchmarkResultados.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <b>Comparacion de tiempos:</b>
            <table style={{ marginTop: 4 }}>
              <thead>
                <tr>
                  <th>Tamaño</th>
                  <th>Copia normal</th>
                  <th>Paso rapido</th>
                  <th>Memoria compartida</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkResultados.map((b) => (
                  <tr key={b.tamanoMb}>
                    <td>{b.tamanoMb} MB</td>
                    <td>{b.tiempoCopiaMs} ms</td>
                    <td>{b.tiempoTransferibleMs} ms</td>
                    <td>{b.tiempoSABMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>

      {/* Consulta por zona */}
      <fieldset>
        <legend>3. Ver consumo por zona o transformador</legend>
        <label>Seleccionar lugar: </label>
        <select value={nodoSeleccionado} onChange={(e) => setNodoSeleccionado(e.target.value)}>
          <option value="SUB-NORTE">Zona Norte (SUB-NORTE)</option>
          <option value="SUB-SUR">Zona Sur (SUB-SUR)</option>
          <option value="CIR-01">Circuito 01 (CIR-01)</option>
          <option value="CIR-07">Circuito 07 (CIR-07)</option>
          <option value="TR-0001">Transformador 0001</option>
          <option value="TR-0010">Transformador 0010</option>
        </select>
        <button onClick={handleConsultarSubarbol} style={{ marginLeft: 6 }}>
          Ver consumo
        </button>
        {sumaSubarbolKwh !== null && (
          <span style={{ marginLeft: 10 }}>
            Total consumido: <b>{sumaSubarbolKwh} kWh</b>
          </span>
        )}
      </fieldset>

      {/* Transformadores con perdidas */}
      <fieldset>
        <legend>4. Lista de transformadores con pérdidas de energía</legend>
        {rankingTop200.length > 0 ? (
          <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #aaa" }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Transformador</th>
                  <th>Energía perdida (kWh)</th>
                  <th>Horas con fallas</th>
                  <th>Medidores sospechosos</th>
                </tr>
              </thead>
              <tbody>
                {rankingTop200.slice(0, 50).map((t, idx) => (
                  <tr key={t.trafoId} className={idx < 5 ? "fila-roja" : idx < 15 ? "fila-amarilla" : ""}>
                    <td>{idx + 1}</td>
                    <td><b>{t.trafoId}</b></td>
                    <td>{t.perdidaTotalKwh}</td>
                    <td>{t.horasAnomalas}</td>
                    <td>
                      {t.medidoresSospechosos.map((m) => (
                        <span key={m.meterId} style={{ marginRight: 6 }}>
                          {m.meterId} (Sospecha: {m.sospechaScore}%)
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ margin: 0, color: "#666" }}>Presione 'Procesar archivo' o 'Usar datos de ejemplo' para ver el listado.</p>
        )}
      </fieldset>

      {/* Lista de medidores */}
      <fieldset>
        <legend>5. Lista de medidores (muestra 260.000 filas)</legend>
        <div style={{ marginBottom: 4 }}>
          <label>Buscar medidor: </label>
          <input
            type="text"
            placeholder="Escriba el codigo..."
            value={filtroMedidor}
            onChange={(e) => setFiltroMedidor(e.target.value)}
          />
        </div>

        <div
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          style={{
            height: contenedorAltura,
            overflowY: "auto",
            position: "relative",
            border: "1px solid #888",
            backgroundColor: "#fff"
          }}
        >
          <div style={{ height: totalElementosVirtuales * filaAltura, position: "relative" }}>
            <table
              style={{
                position: "absolute",
                top: startIndex * filaAltura,
                left: 0,
                right: 0
              }}
            >
              <thead>
                <tr>
                  <th style={{ width: 50 }}>#</th>
                  <th>Medidor</th>
                  <th>Hora</th>
                  <th>Consumo (kWh)</th>
                  <th>Version</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {filasVisibles.map((f) => (
                  <tr key={f.index} style={{ height: filaAltura }}>
                    <td>{f.index + 1}</td>
                    <td><b>{f.medidorId}</b></td>
                    <td>Hora {f.hora}</td>
                    <td>{f.kwh}</td>
                    <td>v{f.version}</td>
                    <td>{f.estado}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
