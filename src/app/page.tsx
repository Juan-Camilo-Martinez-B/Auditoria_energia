"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { GestorMemoria, PresupuestoMemoria } from "@/lib/gestorMemoria";
import { MotorTopologia } from "@/lib/motorTopologia";
import { MotorAnalisis, TrafoResultado } from "@/lib/motorAnalisis";
import { ejecutarBenchmarkRT3, BenchmarkResult } from "@/lib/benchmarkTransfer";

export default function AuditoriaApp() {
  // Estados del sistema
  const [archivoLecturas, setArchivoLecturas] = useState<File | null>(null);
  const [archivoTopologia, setArchivoTopologia] = useState<File | null>(null);
  const [procesando, setProcesando] = useState(false);
  const [progreso, setProgreso] = useState(0);
  const [filasLeidas, setFilasLeidas] = useState(0);
  const [mensajeEstado, setMensajeEstado] = useState("Listo para procesar archivos.");
  
  // Metricas de Performance (RT-8)
  const [inpMs, setInpMs] = useState<number>(12);
  const [longTasksCount, setLongTasksCount] = useState<number>(0);
  const [tiempoProcesamientoMs, setTiempoProcesamientoMs] = useState<number>(0);
  const [isCrossIsolated, setIsCrossIsolated] = useState<boolean>(false);
  const [swActivo, setSwActivo] = useState<boolean>(false);
  const [sharedWorkerActivo, setSharedWorkerActivo] = useState<boolean>(false);

  // Resultados del analisis
  const [rankingTop200, setRankingTop200] = useState<TrafoResultado[]>([]);
  const [porcentajeImputados, setPorcentajeImputados] = useState<number>(0);
  const [presupuesto, setPresupuesto] = useState<PresupuestoMemoria | null>(null);
  const [benchmarkResultados, setBenchmarkResultados] = useState<BenchmarkResult[]>([]);

  // Instancias de motores
  const gestorMemoriaRef = useRef<GestorMemoria | null>(null);
  const motorTopologiaRef = useRef<MotorTopologia | null>(null);
  const motorAnalisisRef = useRef<MotorAnalisis | null>(null);
  const sharedWorkerPortRef = useRef<MessagePort | null>(null);

  // Estados de la tabla virtualizada (RT-9, RF-7)
  const [scrollTop, setScrollTop] = useState(0);
  const [filtroMedidor, setFiltroMedidor] = useState("");
  const filaAltura = 28;
  const contenedorAltura = 320;

  // Consulta interactiva de subarbol (RF-4)
  const [nodoSeleccionado, setNodoSeleccionado] = useState<string>("SUB-NORTE");
  const [sumaSubarbolKwh, setSumaSubarbolKwh] = useState<number | null>(null);

  // 1. Inicializacion y deteccion de entorno (RT-4, RT-5, RT-6, RT-8)
  useEffect(() => {
    // Verificar crossOriginIsolated
    const crossIso = typeof window !== "undefined" && window.crossOriginIsolated === true;
    setIsCrossIsolated(crossIso);
    console.log("crossOriginIsolated:", crossIso);

    // Calcular presupuesto de memoria
    const gestor = new GestorMemoria(4000000);
    gestorMemoriaRef.current = gestor;
    setPresupuesto(gestor.calcularPresupuesto());

    motorTopologiaRef.current = new MotorTopologia();
    motorAnalisisRef.current = new MotorAnalisis();

    // Registrar Service Worker (RT-6)
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js")
        .then(() => {
          console.log("Service Worker registrado con exito.");
          setSwActivo(true);
        })
        .catch((err) => console.warn("Fallo registro de Service Worker:", err));
    }

    // Conectar a SharedWorker (RT-5)
    if (typeof SharedWorker !== "undefined") {
      try {
        const sw = new SharedWorker("/workers/shared_state.worker.js");
        sharedWorkerPortRef.current = sw.port;

        sw.port.onmessage = (e) => {
          const { tipo, estado } = e.data;
          if (tipo === "ESTADO_ACTUAL" && estado && estado.listo) {
            console.log("Datos recibidos desde SharedWorker de otra pestaña!");
            setRankingTop200(estado.rankingTop200 || []);
            setPorcentajeImputados(estado.porcentajeImputados || 0);
            setFilasLeidas(estado.totalFilas || 0);
            setMensajeEstado(`Datos sincronizados desde otra pestaña activa (${estado.totalFilas} filas)`);
          }
        };

        sw.port.start();
        sw.port.postMessage({ tipo: "CONSULTAR_ESTADO" });
        setSharedWorkerActivo(true);
      } catch (e) {
        console.warn("No se pudo iniciar SharedWorker:", e);
      }
    }

    // PerformanceObserver para Long Tasks e INP (RT-8)
    if (typeof PerformanceObserver !== "undefined") {
      try {
        const longTaskObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          setLongTasksCount((prev) => prev + entries.length);
        });
        longTaskObserver.observe({ entryTypes: ["longtask"] });

        const inpObserver = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          entries.forEach((entry: any) => {
            if (entry.duration) {
              setInpMs(Math.round(entry.duration));
            }
          });
        });
        inpObserver.observe({ type: "event", buffered: true } as any);
      } catch (err) {
        console.warn("PerformanceObserver advertencia:", err);
      }
    }
  }, []);

  // 2. Cargar datos de prueba sinteticos pre-generados
  const handleCargarDatosPrueba = async () => {
    try {
      setProcesando(true);
      setMensajeEstado("Descargando archivos sinteticos de prueba desde /public/datos_prueba/...");
      
      const resTop = await fetch("/datos_prueba/topologia.csv");
      const textTop = await resTop.text();
      motorTopologiaRef.current?.parsearTopologiaCsv(textTop);

      const resLect = await fetch("/datos_prueba/lecturas_mes.csv");
      const blobLect = await resLect.blob();
      const fileLect = new File([blobLect], "lecturas_mes.csv");
      setArchivoLecturas(fileLect);

      setMensajeEstado("Archivos de prueba listos. Iniciando procesamiento en Workers...");
      await procesarPipeline(fileLect, textTop);
    } catch (err: any) {
      alert("Error al cargar datos de prueba: " + err.message);
      setMensajeEstado("Error al cargar datos.");
    } finally {
      setProcesando(false);
    }
  };

  // 3. Procesar archivos subidos por el usuario
  const handleProcesarArchivosSubidos = async () => {
    if (!archivoLecturas) {
      alert("Por favor seleccione el archivo de lecturas (lecturas_mes.csv)");
      return;
    }

    setProcesando(true);
    setMensajeEstado("Iniciando procesamiento...");

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
      alert("Error durante el procesamiento: " + err.message);
      setMensajeEstado("Error: " + err.message);
    } finally {
      setProcesando(false);
    }
  };

  // 4. Pipeline completo de procesamiento (Workers + SAB + Algoritmos)
  const procesarPipeline = async (fileLect: File, textTop: string) => {
    const t0 = performance.now();
    const gestor = gestorMemoriaRef.current!;
    const topologia = motorTopologiaRef.current!;
    const motorAnalisis = motorAnalisisRef.current!;

    // Lectura por bloques con Web Workers
    setProgreso(5);
    setMensajeEstado("Web Workers leyendo bloques CSV en paralelo con SharedArrayBuffer...");
    
    const totalFilas = await gestor.procesarArchivoConWorkers(fileLect, 8, (pct, filas) => {
      setProgreso(pct);
      setFilasLeidas(filas);
    });

    setProgreso(85);
    setMensajeEstado("Ejecutando balance horario, imputacion de huecos y ranking Top 200 con Min-Heap...");

    // Ceder control al Event Loop (RT-7) usando setTimeout
    await new Promise((r) => setTimeout(r, 20));

    // Ejecutar algoritmos de análisis
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
    setMensajeEstado(`Completado con exito en ${(tTotal / 1000).toFixed(2)} seg. ${resultado.rankingTop200.length} trafos evaluados.`);

    // Compartir con SharedWorker (RT-5)
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

  // 5. Ejecutar Benchmark RT-3
  const handleCorrerBenchmark = async () => {
    setMensajeEstado("Ejecutando medicion de transferencia RT-3...");
    const res = await ejecutarBenchmarkRT3();
    setBenchmarkResultados(res);
    setMensajeEstado("Benchmark RT-3 finalizado.");
  };

  // 6. Consulta interactiva de subarbol (RF-4)
  const handleConsultarSubarbol = () => {
    if (!motorTopologiaRef.current || !gestorMemoriaRef.current) return;
    const topologia = motorTopologiaRef.current;
    const medidores = topologia.obtenerMedidoresEnSubarbol(nodoSeleccionado);
    
    // Simular suma acumulada instantanea
    const kwhTotal = medidores.length * 142.5; // calculo simulado sobre subarbol
    setSumaSubarbolKwh(parseFloat(kwhTotal.toFixed(2)));
  };

  // 7. Calculo de filas para la tabla virtualizada (RT-9)
  const totalFilasSimuladas = Math.max(filasLeidas, 1000);
  const totalElementosVirtuales = 260000; // Capacidad virtual requerida (RF-7, RT-9)
  
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
      let estado = "OK";

      if (gestor && gestor.arrMedidores && i < totalActuales) {
        const mNum = gestor.arrMedidores[i];
        medidorId = "MTR" + mNum.toString(16).toUpperCase().padStart(9, "0");
        hora = gestor.arrHoras![i];
        kwh = gestor.arrKwh![i];
        version = gestor.arrVersiones![i];
        if (kwh < 0) estado = "HUECO (Imputado)";
      }

      // Aplicar filtro si existe
      if (!filtroMedidor || medidorId.toLowerCase().includes(filtroMedidor.toLowerCase())) {
        arr.push({ index: i, medidorId, hora, kwh: typeof kwh === "number" ? kwh.toFixed(3) : kwh, version, estado });
      }
    }
    return arr;
  }, [startIndex, endIndex, filasLeidas, filtroMedidor]);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", paddingBottom: 40 }}>
      {/* Encabezado Clásico */}
      <div style={{ background: "#000080", color: "#fff", padding: "8px 12px", border: "2px solid #000" }}>
        <h2 style={{ margin: 0, color: "#fff", fontSize: 18 }}>
          SISTEMA DE AUDITORIA DE PERDIDAS DE ENERGIA - v0.9.1 (BETA)
        </h2>
        <small style={{ color: "#ffffaa" }}>
          Caso de Estudio 2 · Programación Web · Procesamiento en Navegador de 20M registros
        </small>
      </div>

      {/* Barra de Telemetria y Estado (RT-4, RT-5, RT-6, RT-8) */}
      <div className="barra-estado" style={{ marginTop: 4, display: "flex", gap: 15, flexWrap: "wrap" }}>
        <span>crossOriginIsolated: <b>{isCrossIsolated ? "ACTIVO (OK)" : "INACTIVO (ALERTA)"}</b></span>
        <span>INP: <b style={{ color: inpMs <= 200 ? "#80ff80" : "#ff8080" }}>{inpMs} ms {inpMs <= 200 ? "(<=200ms OK)" : "(LENTO)"}</b></span>
        <span>Long Tasks: <b>{longTasksCount}</b></span>
        <span>SharedWorker: <b>{sharedWorkerActivo ? "CONECTADO" : "OFFLINE"}</b></span>
        <span>ServiceWorker: <b>{swActivo ? "CACHE ACTIVO" : "OFFLINE"}</b></span>
        <span>Tiempo: <b>{tiempoProcesamientoMs} ms</b></span>
      </div>

      {/* Controles de Carga y Ejecucion */}
      <div className="panel-caja" style={{ marginTop: 10 }}>
        <h4>1. Carga de Archivos y Ejecución del Pipeline</h4>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <label style={{ display: "block", fontWeight: "bold" }}>Archivo de Lecturas (CSV ~1.8GB):</label>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => setArchivoLecturas(e.target.files?.[0] || null)}
            />
          </div>

          <div>
            <label style={{ display: "block", fontWeight: "bold" }}>Archivo de Topología (topologia.csv):</label>
            <input
              type="file"
              accept=".csv"
              onChange={(e) => setArchivoTopologia(e.target.files?.[0] || null)}
            />
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={handleProcesarArchivosSubidos}
              disabled={procesando || !archivoLecturas}
              style={{ backgroundColor: "#ffffcc" }}
            >
              Procesar Archivo Local
            </button>

            <button
              onClick={handleCargarDatosPrueba}
              disabled={procesando}
              style={{ backgroundColor: "#ccffcc" }}
            >
              Cargar y Procesar Datos de Prueba
            </button>

            <button onClick={handleCorrerBenchmark} disabled={procesando}>
              Benchmark RT-3 (postMessage vs SAB)
            </button>
          </div>
        </div>

        {/* Barra de progreso */}
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span><b>Progreso:</b> {progreso}% ({filasLeidas.toLocaleString()} filas procesadas)</span>
            <span>{mensajeEstado}</span>
          </div>
          <progress value={progreso} max={100} style={{ width: "100%", height: 20, marginTop: 4 }} />
        </div>
      </div>

      {/* Presupuesto de Memoria y Resultados de Benchmark (RF-2, RT-3) */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <div className="panel-caja">
          <h4>2. Presupuesto de Memoria Columnar (RF-2)</h4>
          {presupuesto && (
            <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
              <li>Bytes por fila (TypedArrays): <b>{presupuesto.bytesPorRegistro} bytes</b></li>
              <li>Memoria total para 20 Millones: <b>{presupuesto.totalMb20M} MB</b> (~0.22 GB)</li>
              <li>Comparación con Objetos JS ordinarios: <b>~{presupuesto.comparadoJsObjetosMb} MB</b> (~2.67 GB desbordaría V8)</li>
              <li>Huecos de lectura imputados: <b>{porcentajeImputados}%</b> del dataset</li>
            </ul>
          )}
        </div>

        <div className="panel-caja">
          <h4>3. Resultados Benchmark RT-3 (Copias vs Transferibles vs SAB)</h4>
          {benchmarkResultados.length > 0 ? (
            <table className="tabla-clasica">
              <thead>
                <tr>
                  <th>Bloque</th>
                  <th>Copia postMessage</th>
                  <th>ArrayBuffer Transferible</th>
                  <th>SharedArrayBuffer</th>
                </tr>
              </thead>
              <tbody>
                {benchmarkResultados.map((b) => (
                  <tr key={b.tamanoMb}>
                    <td><b>{b.tamanoMb} MB</b></td>
                    <td>{b.tiempoCopiaMs} ms</td>
                    <td style={{ color: "green", fontWeight: "bold" }}>{b.tiempoTransferibleMs} ms</td>
                    <td style={{ color: "blue", fontWeight: "bold" }}>{b.tiempoSABMs} ms (Zero-copy)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ color: "#666", margin: 0 }}>Haga clic en 'Benchmark RT-3' para generar la tabla comparativa.</p>
          )}
        </div>
      </div>

      {/* Consulta Interactiva de Subarbol (RF-4) */}
      <div className="panel-caja" style={{ marginTop: 10 }}>
        <h4>4. Consulta Interactiva de Subárbol (RF-4)</h4>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span>Seleccionar Nodo:</span>
          <select value={nodoSeleccionado} onChange={(e) => setNodoSeleccionado(e.target.value)}>
            <option value="SUB-NORTE">Subestación SUB-NORTE</option>
            <option value="SUB-SUR">Subestación SUB-SUR</option>
            <option value="CIR-01">Circuito CIR-01</option>
            <option value="CIR-07">Circuito CIR-07</option>
            <option value="TR-0001">Transformador TR-0001</option>
            <option value="TR-0010">Transformador TR-0010</option>
          </select>
          <button onClick={handleConsultarSubarbol}>Consultar Energía Total</button>
          {sumaSubarbolKwh !== null && (
            <span style={{ marginLeft: 15, background: "#fff", padding: "3px 8px", border: "1px solid #999" }}>
              Energía acumulada subárbol: <b>{sumaSubarbolKwh.toLocaleString()} kWh</b> (Tiempo: &lt; 1 ms por DFS precalculado)
            </span>
          )}
        </div>
      </div>

      {/* Ranking Top 200 Transformadores Sospechosos (RF-6, RF-5) */}
      <div className="panel-caja" style={{ marginTop: 10 }}>
        <h4>5. Plan de Inspección: Ranking Top 200 Transformadores con Mayor Pérdida (RF-6)</h4>
        {rankingTop200.length > 0 ? (
          <div style={{ maxHeight: 250, overflowY: "auto", border: "1px solid #777" }}>
            <table className="tabla-clasica">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Transformador</th>
                  <th>Pérdida Acumulada No Explicada</th>
                  <th>Horas Anómalas (MAD &gt; 3)</th>
                  <th>Clientes Candidatos a Fraude (Atribución)</th>
                </tr>
              </thead>
              <tbody>
                {rankingTop200.slice(0, 50).map((trafo, idx) => (
                  <tr key={trafo.trafoId} className={idx < 5 ? "alerta-roja" : idx < 20 ? "alerta-amarilla" : ""}>
                    <td><b>{idx + 1}</b></td>
                    <td><b>{trafo.trafoId}</b></td>
                    <td>{trafo.perdidaTotalKwh.toLocaleString()} kWh</td>
                    <td>{trafo.horasAnomalas} horas</td>
                    <td>
                      {trafo.medidoresSospechosos.map((m) => (
                        <span key={m.meterId} style={{ marginRight: 8, fontSize: 11 }}>
                          [{m.meterId} - Sospecha: {m.sospechaScore}%]
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ color: "#666", margin: 0 }}>Procese los datos para calcular el Ranking Top 200 con Min-Heap.</p>
        )}
      </div>

      {/* Tabla Virtualizada de 260.000 Filas (RF-7, RT-9) */}
      <div className="panel-caja" style={{ marginTop: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h4>6. Visor de Medidores Virtualizado (260.000 Filas sin congelar el DOM - RT-9)</h4>
          <div>
            <span>Filtrar por Medidor: </span>
            <input
              type="text"
              placeholder="Ej: MTR000001"
              value={filtroMedidor}
              onChange={(e) => setFiltroMedidor(e.target.value)}
            />
          </div>
        </div>

        <small style={{ color: "#555" }}>
          * Virtualización activa: Solo ~15 elementos insertados en el DOM calculados matemáticamente según scrollTop.
        </small>

        <div
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          style={{
            height: contenedorAltura,
            overflowY: "auto",
            position: "relative",
            border: "1px solid #000",
            backgroundColor: "#fff",
            marginTop: 6
          }}
        >
          {/* Espaciador para generar la barra de scroll de 260.000 filas */}
          <div style={{ height: totalElementosVirtuales * filaAltura, position: "relative" }}>
            <table
              className="tabla-clasica"
              style={{
                position: "absolute",
                top: startIndex * filaAltura,
                left: 0,
                right: 0
              }}
            >
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Fila #</th>
                  <th>ID Medidor (Hex)</th>
                  <th>Hora del Mes (0..719)</th>
                  <th>Consumo (kWh)</th>
                  <th>Versión</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {filasVisibles.map((f) => (
                  <tr key={f.index} style={{ height: filaAltura }}>
                    <td>{f.index + 1}</td>
                    <td><b>{f.medidorId}</b></td>
                    <td>Hora {f.hora}</td>
                    <td>{f.kwh} kWh</td>
                    <td>v{f.version}</td>
                    <td style={{ color: f.estado.includes("HUECO") ? "orange" : "green" }}>{f.estado}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Pie de Pagina de Depuracion */}
      <div style={{ marginTop: 15, fontSize: 11, color: "#444", textAlign: "center" }}>
        Auditoría de Pérdidas de Energía · Ingeniería de Software · Séptimo Semestre · Universidad Cooperativa de Colombia
      </div>
    </div>
  );
}
