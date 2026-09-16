// generador_datos.js
// Script para generar datos sinteticos para la tarea de auditoria de energia
// Hecho por estudiante de 7mo semestre (un poco a las carreras pero funciona)

const fs = require('fs');
const path = require('path');

// Parametros configurables
const NUM_MEDIDORES = process.env.MEDIDORES ? parseInt(process.env.MEDIDORES) : 5000; // Por defecto 5000 para pruebas rapidas, se puede subir a 260000
const HORAS_MES = 720; // 30 dias * 24 horas
const TS_INICIO = 1767225600; // Epoch inicial (ejemplo del PDF)
const PORC_HUECOS = 0.06; // 6% de huecos
const PORC_DUPLICADOS = 0.012; // 1.2% duplicados con version mas alta
const NUM_TRASLADOS = Math.min(300, Math.floor(NUM_MEDIDORES * 0.015)); // medidores que cambian de trafo
const NUM_FRAUDES = 15; // fraudes inyectados a proposito

console.log("=== GENERADOR DE DATOS SINTETICOS DE ENERGIA ===");
console.log(`Medidores: ${NUM_MEDIDORES}`);
console.log(`Horas del mes: ${HORAS_MES}`);
console.log(`Iniciando generacion de archivos en ./public/datos_prueba/ ...`);

const salidaDir = path.join(__dirname, '..', 'public', 'datos_prueba');
if (!fs.existsSync(salidaDir)) {
  fs.mkdirSync(salidaDir, { recursive: true });
}

// Generar IDs de medidores en Hex de 12 caracteres (como pide el PDF: A1F20C39D4B8)
function generarHexId(numero) {
  let hex = numero.toString(16).toUpperCase().padStart(12, '0');
  return "MTR" + hex.substring(3); // Ejemplo: MTR000000001
}

const listaMedidores = [];
for (let i = 0; i < NUM_MEDIDORES; i++) {
  listaMedidores.push(generarHexId(i + 1));
}

// 1. Generar Topologia: SUBESTACION > CIRCUITO > TRAFO > MEDIDOR
console.log("Generando topologia...");
const fileTopologia = path.join(salidaDir, 'topologia.csv');
const streamTopologia = fs.createWriteStream(fileTopologia);

streamTopologia.write("nodo_id,tipo,padre_id,desde,hasta\n");

// Subestaciones y Circuitos fijos
const subestaciones = ["SUB-NORTE", "SUB-SUR", "SUB-ORIENTE", "SUB-OCCIDENTE"];
subestaciones.forEach(sub => {
  streamTopologia.write(`${sub},SUBESTACION,,1735689600,4102444800\n`);
});

const circuitos = [];
for (let i = 1; i <= 12; i++) {
  const cirId = `CIR-${i < 10 ? '0' + i : i}`;
  const subPadre = subestaciones[i % subestaciones.length];
  circuitos.push(cirId);
  streamTopologia.write(`${cirId},CIRCUITO,${subPadre},1735689600,4102444800\n`);
}

// Transformadores (1 trafo cada ~25 medidores)
const numTrafos = Math.max(10, Math.ceil(NUM_MEDIDORES / 25));
const trafos = [];
for (let i = 1; i <= numTrafos; i++) {
  const trafoId = `TR-${String(i).padStart(4, '0')}`;
  const cirPadre = circuitos[i % circuitos.length];
  trafos.push(trafoId);
  streamTopologia.write(`${trafoId},TRAFO,${cirPadre},1735689600,4102444800\n`);
}

// Asignar medidores a trafos (con traslados a mitad de mes para algunos)
const medidoresConTraslado = new Set();
while (medidoresConTraslado.size < NUM_TRASLADOS) {
  medidoresConTraslado.add(Math.floor(Math.random() * NUM_MEDIDORES));
}

const TS_TRASLADO = TS_INICIO + (360 * 3600); // Dia 15 a mitad de mes

for (let i = 0; i < NUM_MEDIDORES; i++) {
  const medId = listaMedidores[i];
  const trafoInicial = trafos[i % trafos.length];
  
  if (medidoresConTraslado.has(i)) {
    // Tiene dos filas de vigencia
    const trafoNuevo = trafos[(i + 3) % trafos.length];
    streamTopologia.write(`${medId},MEDIDOR,${trafoInicial},1735689600,${TS_TRASLADO}\n`);
    streamTopologia.write(`${medId},MEDIDOR,${trafoNuevo},${TS_TRASLADO},4102444800\n`);
  } else {
    // Vigencia completa
    streamTopologia.write(`${medId},MEDIDOR,${trafoInicial},1735689600,4102444800\n`);
  }
}

streamTopologia.end();
console.log(`Topologia lista: ${fileTopologia}`);

// 2. Generar Lecturas (lecturas_mes.csv)
console.log("Generando lecturas de medidores...");
const fileLecturas = path.join(salidaDir, 'lecturas_mes.csv');
const streamLecturas = fs.createWriteStream(fileLecturas);

streamLecturas.write("meter_id,ts,kwh,version,flags\n");

// Elegimos medidores para inyectar fraudes conocidos
const medidoresFraude = new Map();
for (let f = 0; f < NUM_FRAUDES; f++) {
  const idx = (f * 37 + 11) % NUM_MEDIDORES;
  medidoresFraude.set(listaMedidores[idx], {
    horaInicio: 100 + (f * 20),
    tipo: f % 2 === 0 ? 'manipulacion_caida_70%' : 'puente_cero'
  });
}

// Guardar reporte de fraudes inyectados para verificar luego
const fileReporteFraudes = path.join(salidaDir, 'fraudes_sembrados.json');
fs.writeFileSync(fileReporteFraudes, JSON.stringify(Array.from(medidoresFraude.entries()), null, 2));

let totalFilas = 0;

for (let h = 0; h < HORAS_MES; h++) {
  const ts = TS_INICIO + (h * 3600);
  const esFinDeSemana = ((Math.floor(h / 24)) % 7) >= 5;
  const horaDelDia = h % 24;

  for (let m = 0; m < NUM_MEDIDORES; m++) {
    const medId = listaMedidores[m];
    
    // Consumo base con perfil realista diario
    let consumoBase = 0.25 + 0.2 * Math.sin((horaDelDia - 6) * Math.PI / 12);
    if (consumoBase < 0.05) consumoBase = 0.05;
    if (esFinDeSemana) consumoBase *= 1.15;
    // algo de ruido aleatorio
    let kwh = +(consumoBase + (Math.random() * 0.1 - 0.05)).toFixed(3);
    let flags = 0;
    let version = 1;

    // Verificar si es fraude inyectado
    if (medidoresFraude.has(medId)) {
      const infoFraude = medidoresFraude.get(medId);
      if (h >= infoFraude.horaInicio) {
        if (infoFraude.tipo === 'manipulacion_caida_70%') {
          kwh = +(kwh * 0.25).toFixed(3); // reduce un 75%
        } else {
          kwh = 0.005; // puente directo casi a cero
        }
      }
    }

    // Huecos de lectura (5-8%)
    const esHueco = Math.random() < PORC_HUECOS;
    if (esHueco) {
      flags |= 2; // bit1 hueco
      streamLecturas.write(`${medId},${ts},,${version},${flags}\n`);
      totalFilas++;
      continue;
    }

    // Flujo inverso ocasional (bit 2)
    if (Math.random() < 0.003) {
      flags |= 4; // bit2 flujo inverso
      kwh = -Math.abs(kwh);
    }

    streamLecturas.write(`${medId},${ts},${kwh},${version},${flags}\n`);
    totalFilas++;

    // Duplicados con version (1.2%)
    if (Math.random() < PORC_DUPLICADOS) {
      const versionMayor = 2;
      const kwhCorregido = +(kwh * 1.05).toFixed(3);
      streamLecturas.write(`${medId},${ts},${kwhCorregido},${versionMayor},${flags}\n`);
      totalFilas++;
    }
  }
}

streamLecturas.end();
console.log(`Lecturas generadas con exito: ${fileLecturas}`);
console.log(`Total de filas escritas: ${totalFilas}`);
console.log(`Fraudes sembrados guardados en: ${fileReporteFraudes}`);
