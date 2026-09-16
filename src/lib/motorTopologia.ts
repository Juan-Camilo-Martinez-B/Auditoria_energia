// motorTopologia.ts
// Modulo para jerarquia de red, vigencias de medidores y consultas de subarbol (RF-4)
// Estilo: Algoritmo directo de estudiante de 7mo semestre

export interface VigenciaMedidor {
  trafoId: string;
  desde: number;
  hasta: number;
}

export interface NodoJerarquia {
  id: string;
  tipo: 'SUBESTACION' | 'CIRCUITO' | 'TRAFO' | 'MEDIDOR';
  padreId: string;
  hijos: string[];
  inDfs?: number;
  outDfs?: number;
}

export class MotorTopologia {
  nodos: Map<string, NodoJerarquia> = new Map();
  // Mapa de medidor -> lista de vigencias ordenadas por fecha
  vigenciasMedidores: Map<string, VigenciaMedidor[]> = new Map();
  trafosLista: string[] = [];
  subestaciones: string[] = [];
  ordenDfs: string[] = [];

  // Parsear el archivo topologia.csv
  parsearTopologiaCsv(csvTexto: string) {
    console.log("Parseando topologia.csv...");
    const lineas = csvTexto.split('\n');
    let inicio = 0;
    if (lineas[0].includes('nodo_id')) inicio = 1;

    for (let i = inicio; i < lineas.length; i++) {
      const linea = lineas[i].trim();
      if (!linea) continue;
      const partes = linea.split(',');
      if (partes.length < 5) continue;

      const nodoId = partes[0].trim();
      const tipo = partes[1].trim() as NodoJerarquia['tipo'];
      const padreId = partes[2].trim();
      const desde = parseInt(partes[3]) || 0;
      const hasta = parseInt(partes[4]) || 4102444800;

      // Registrar nodo en el mapa si no existe
      if (!this.nodos.has(nodoId)) {
        this.nodos.set(nodoId, {
          id: nodoId,
          tipo: tipo,
          padreId: padreId,
          hijos: []
        });
      }

      if (tipo === 'SUBESTACION' && !this.subestaciones.includes(nodoId)) {
        this.subestaciones.push(nodoId);
      }
      if (tipo === 'TRAFO' && !this.trafosLista.includes(nodoId)) {
        this.trafosLista.push(nodoId);
      }

      // Enlazar hijos con padres
      if (padreId) {
        if (!this.nodos.has(padreId)) {
          this.nodos.set(padreId, {
            id: padreId,
            tipo: tipo === 'MEDIDOR' ? 'TRAFO' : tipo === 'TRAFO' ? 'CIRCUITO' : 'SUBESTACION',
            padreId: '',
            hijos: []
          });
        }
        const nodoPadre = this.nodos.get(padreId)!;
        if (!nodoPadre.hijos.includes(nodoId)) {
          nodoPadre.hijos.push(nodoId);
        }
      }

      // Guardar vigencias si es medidor (para traslados)
      if (tipo === 'MEDIDOR') {
        if (!this.vigenciasMedidores.has(nodoId)) {
          this.vigenciasMedidores.set(nodoId, []);
        }
        this.vigenciasMedidores.get(nodoId)!.push({
          trafoId: padreId,
          desde: desde,
          hasta: hasta
        });
      }
    }

    // Ordenar intervalos de vigencia por fecha de inicio
    for (const [_, lista] of this.vigenciasMedidores.entries()) {
      lista.sort((a, b) => a.desde - b.desde);
    }

    // Linealizar arbol con recorrido DFS para consultas rapidas de subarbol (RF-4)
    this.linealizarArbolDFS();
    console.log("Topologia cargada. Trafos: " + this.trafosLista.length + ", Medidores con vigencia: " + this.vigenciasMedidores.size);
  }

  // Busqueda binaria de transformador padre segun timestamp (RF-4: Vigencias por fecha)
  obtenerTrafoPadreVigente(medidorId: string, epochSegundos: number): string | null {
    const lista = this.vigenciasMedidores.get(medidorId);
    if (!lista || lista.length === 0) return null;
    if (lista.length === 1) return lista[0].trafoId;

    // Busqueda binaria sobre los intervalos de vigencia
    let low = 0;
    let high = lista.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const vig = lista[mid];
      if (epochSegundos >= vig.desde && epochSegundos < vig.hasta) {
        return vig.trafoId;
      }
      if (epochSegundos < vig.desde) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    // Si cayo por fuera de rango devolver el ultimo conocido
    return lista[lista.length - 1].trafoId;
  }

  // Linealizacion DFS (Euler Tour) para calcular rangos [inDfs, outDfs]
  private linealizarArbolDFS() {
    let contador = 0;
    this.ordenDfs = [];

    const dfs = (nodoId: string) => {
      const nodo = this.nodos.get(nodoId);
      if (!nodo) return;
      nodo.inDfs = contador++;
      this.ordenDfs.push(nodoId);

      for (const hijoId of nodo.hijos) {
        dfs(hijoId);
      }
      nodo.outDfs = contador - 1;
    };

    // Recorrer desde las raices (Subestaciones)
    for (const sub of this.subestaciones) {
      dfs(sub);
    }
  }

  // Obtener todos los medidores que descienden de un nodo
  obtenerMedidoresEnSubarbol(nodoId: string): string[] {
    const nodo = this.nodos.get(nodoId);
    if (!nodo) return [];

    const resultado: string[] = [];
    const stack = [nodoId];

    while (stack.length > 0) {
      const curr = stack.pop()!;
      const n = this.nodos.get(curr);
      if (!n) continue;
      if (n.tipo === 'MEDIDOR') {
        resultado.push(n.id);
      }
      for (const h of n.hijos) {
        stack.push(h);
      }
    }

    return resultado;
  }
}
