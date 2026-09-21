import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Download, Eye, RefreshCw, Search, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { dbm, nivel } from '../../lib/optica'
import { Badge, Button, Card, ErrorBanner, Input, Select, SkeletonTabla, Table } from '../../components/ui'

/**
 * Todas las ONUs autorizadas, de todas las OLTs.
 *
 * Es la pantalla a la que se llega cuando uno tiene un dato suelto —una serie
 * anotada en un papel, un nombre a medias, una VLAN— y necesita encontrar de
 * qué abonado es. Por eso el buscador mira a la vez la serie, el nombre, la
 * dirección y la ruta que escribe la CLI (gpon-onu_0/6/9:17): así se puede
 * pegar cualquier cosa copiada de cualquier lado.
 *
 * Se pagina en el servidor. Con novecientas ONUs, traerlas todas al navegador
 * para mostrar cien es bajar nueve veces lo necesario en cada carga.
 */

const POR_PAGINA = 100

const ESTADOS = {
  online: { label: 'En línea', color: 'verde' },
  offline: { label: 'Caída', color: 'gris' },
  los: { label: 'Sin luz (LOS)', color: 'rojo' },
  power_off: { label: 'Sin energía', color: 'ambar' },
  unknown: { label: 'Suspendida', color: 'azul' },
}

export default function OnusPage() {
  const [filas, setFilas] = useState(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState(null)
  const [pagina, setPagina] = useState(0)
  const [olts, setOlts] = useState([])
  const [opciones, setOpciones] = useState({})

  /**
   * Los filtros arrancan vacíos, salvo los que vengan en la dirección.
   *
   * El panel de inicio enlaza acá con `?senal=baja` para que su tarjeta de
   * señal baja abra la lista hecha. Antes esa tarjeta llevaba a Métricas
   * ópticas, que es otra cosa: ahí hay que elegir OLT y puerto y mandar a leer
   * el equipo en vivo, una ONU por vez. Para saber cuáles están bajas no hace
   * falta escanear nada — el dato ya está guardado y esta pantalla ya lo
   * filtra para todas las OLTs a la vez.
   *
   * Se acepta cualquiera de los filtros, no solo la señal: así una alerta
   * puede enlazar a una OLT o a un puerto concreto sin tocar más código.
   */
  const [params] = useSearchParams()
  const [f, setF] = useState(() => {
    const vacio = {
      q: '',
      olt_id: '',
      slot: '',
      puerto: '',
      zona: '',
      vlan: '',
      modelo: '',
      odb: '',
      estado: '',
      senal: '',
      abonado: '',
    }
    return Object.fromEntries(
      Object.keys(vacio).map((k) => [k, params.get(k) ?? vacio[k]]),
    )
  })

  useEffect(() => {
    supabase
      .from('olts')
      .select('id, nombre, numero')
      .order('numero')
      .then(({ data }) => setOlts(data ?? []))

    // Los valores de los filtros salen de una vista que los cuenta en la base.
    // Deducirlos de las filas cargadas mostraría solo los de la página actual.
    supabase
      .from('v_onus_filtros')
      .select('*')
      .then(({ data }) => {
        const por = {}
        for (const x of data ?? []) (por[x.campo] ??= []).push(x)
        for (const k of Object.keys(por)) {
          por[k].sort((a, b) =>
            Number.isFinite(Number(a.valor)) && Number.isFinite(Number(b.valor))
              ? Number(a.valor) - Number(b.valor)
              : String(a.valor).localeCompare(String(b.valor)),
          )
        }
        setOpciones(por)
      })
  }, [])

  const cargar = useCallback(async () => {
    setFilas(null)
    let q = supabase.from('v_onus_clientes').select('*', { count: 'exact' })

    if (f.olt_id) q = q.eq('olt_id', f.olt_id)
    if (f.slot !== '') q = q.eq('slot', Number(f.slot))
    if (f.puerto !== '') q = q.eq('puerto', Number(f.puerto))
    if (f.zona) q = q.eq('zona', f.zona)
    if (f.vlan) q = q.eq('vlan', Number(f.vlan))
    if (f.modelo) q = q.eq('modelo', f.modelo)
    if (f.odb) q = q.eq('odb', f.odb)
    if (f.estado) q = q.eq('onu_estado', f.estado)
    if (f.senal === 'baja') q = q.eq('senal_baja', true)
    if (f.senal === 'sin_lectura') q = q.is('rx_power_dbm', null)
    if (f.abonado === 'sin') q = q.eq('sin_abonado', true)
    if (f.abonado === 'con') q = q.eq('sin_abonado', false)

    if (f.q.trim()) {
      // La serie se busca sin distinguir mayúsculas ni guiones: se copia de
      // etiquetas, de la CLI y de mensajes de WhatsApp, y nunca viene igual.
      const t = f.q.trim().replace(/[\s-]/g, '')
      q = q.or(
        [
          `sn.ilike.%${t}%`,
          `nombre_en_la_olt.ilike.%${f.q.trim()}%`,
          `cliente.ilike.%${f.q.trim()}%`,
          `direccion.ilike.%${f.q.trim()}%`,
          `ruta_onu.ilike.%${f.q.trim()}%`,
        ].join(','),
      )
    }

    const desde = pagina * POR_PAGINA
    const { data, error: err, count } = await q
      .order('autorizada_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .range(desde, desde + POR_PAGINA - 1)

    if (err) {
      setError(
        err.code === '42703' || err.code === '42P01'
          ? {
              message: 'Falta la migración 44',
              hint: 'Corré supabase/migracion-44-ficha-de-onu.sql en el SQL Editor.',
            }
          : err,
      )
      setFilas([])
      return
    }
    setError(null)
    setFilas(data ?? [])
    setTotal(count ?? 0)
  }, [f, pagina])

  useEffect(() => {
    cargar()
  }, [cargar])

  // Cambiar un filtro vuelve a la primera página: quedarse en la 7 de un
  // resultado que ahora tiene 2 muestra una tabla vacía que parece un error.
  const set = (campo, valor) => {
    setPagina(0)
    setF((x) => ({ ...x, [campo]: valor }))
  }

  const filtrosPuestos = Object.entries(f).filter(([, v]) => v !== '').length
  const paginas = Math.ceil(total / POR_PAGINA)
  const desde = pagina * POR_PAGINA + 1
  const hasta = Math.min((pagina + 1) * POR_PAGINA, total)

  function exportar() {
    const cols = [
      'sn', 'cliente', 'nombre_en_la_olt', 'olt', 'ruta_onu', 'zona', 'odb',
      'rx_power_dbm', 'vlan', 'modelo', 'plan', 'onu_estado', 'autorizada_at',
    ]
    const csv = [
      cols.join(','),
      ...(filas ?? []).map((o) =>
        cols.map((c) => `"${String(o[c] ?? '').replace(/"/g, '""')}"`).join(','),
      ),
    ].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    a.download = `onus-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">ONUs autorizadas</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Todas las de todas las OLTs. Los datos son la copia local; la ficha de cada una lee del
            equipo en vivo.
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon={RefreshCw} onClick={cargar}>
            Actualizar
          </Button>
          <Button icon={Download} onClick={exportar} disabled={!filas?.length}>
            Exportar esta página
          </Button>
        </div>
      </div>

      <ErrorBanner error={error} onCerrar={() => setError(null)} />

      <Card>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[280px] flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                value={f.q}
                onChange={(e) => set('q', e.target.value)}
                placeholder="Serie, nombre, dirección o gpon-onu_0/6/9:17"
                className="pl-9"
              />
            </div>
            {filtrosPuestos > 0 && (
              <Button
                variante="fantasma"
                icon={X}
                onClick={() => {
                  setPagina(0)
                  setF(Object.fromEntries(Object.keys(f).map((k) => [k, ''])))
                }}
              >
                Limpiar ({filtrosPuestos})
              </Button>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Filtro label="OLT" valor={f.olt_id} onChange={(v) => set('olt_id', v)}>
              {olts.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.numero ? `${o.numero} · ` : ''}
                  {o.nombre}
                </option>
              ))}
            </Filtro>
            <Filtro label="Placa" valor={f.slot} onChange={(v) => set('slot', v)}>
              {(opciones.slot ?? []).map((x) => (
                <option key={x.valor} value={x.valor}>
                  {x.valor} ({x.cuantas})
                </option>
              ))}
            </Filtro>
            <Filtro label="Puerto" valor={f.puerto} onChange={(v) => set('puerto', v)}>
              {(opciones.puerto ?? []).map((x) => (
                <option key={x.valor} value={x.valor}>
                  {x.valor} ({x.cuantas})
                </option>
              ))}
            </Filtro>
            <Filtro label="Zona" valor={f.zona} onChange={(v) => set('zona', v)}>
              {(opciones.zona ?? []).map((x) => (
                <option key={x.valor} value={x.valor}>
                  {x.valor} ({x.cuantas})
                </option>
              ))}
            </Filtro>
            <Filtro label="Caja / ODB" valor={f.odb} onChange={(v) => set('odb', v)}>
              {(opciones.odb ?? []).map((x) => (
                <option key={x.valor} value={x.valor}>
                  {x.valor} ({x.cuantas})
                </option>
              ))}
            </Filtro>
            <Filtro label="VLAN" valor={f.vlan} onChange={(v) => set('vlan', v)}>
              {(opciones.vlan ?? []).map((x) => (
                <option key={x.valor} value={x.valor}>
                  {x.valor} ({x.cuantas})
                </option>
              ))}
            </Filtro>
            <Filtro label="Modelo" valor={f.modelo} onChange={(v) => set('modelo', v)}>
              {(opciones.modelo ?? []).map((x) => (
                <option key={x.valor} value={x.valor}>
                  {x.valor} ({x.cuantas})
                </option>
              ))}
            </Filtro>
            <Filtro label="Estado" valor={f.estado} onChange={(v) => set('estado', v)}>
              {Object.entries(ESTADOS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Filtro>
            <Filtro label="Señal" valor={f.senal} onChange={(v) => set('senal', v)}>
              <option value="baja">Baja (bajo −27 dBm)</option>
              <option value="sin_lectura">Sin lectura</option>
            </Filtro>
            <Filtro label="Abonado" valor={f.abonado} onChange={(v) => set('abonado', v)}>
              <option value="con">Con ficha</option>
              <option value="sin">Sin ficha</option>
            </Filtro>
          </div>
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            {filas === null
              ? 'Buscando…'
              : total === 0
                ? 'Ninguna ONU coincide'
                : `${desde}–${hasta} de ${total}`}
          </span>
          {paginas > 1 && (
            <span className="flex items-center gap-1">
              <Button variante="fantasma" disabled={pagina === 0} onClick={() => setPagina(0)}>
                «
              </Button>
              <Button
                variante="fantasma"
                disabled={pagina === 0}
                onClick={() => setPagina((p) => p - 1)}
              >
                ‹
              </Button>
              <span className="px-2">
                {pagina + 1} / {paginas}
              </span>
              <Button
                variante="fantasma"
                disabled={pagina + 1 >= paginas}
                onClick={() => setPagina((p) => p + 1)}
              >
                ›
              </Button>
              <Button
                variante="fantasma"
                disabled={pagina + 1 >= paginas}
                onClick={() => setPagina(paginas - 1)}
              >
                »
              </Button>
            </span>
          )}
        </div>

        {filas === null ? (
          <SkeletonTabla filas={10} columnas={8} />
        ) : (
          <Table
            columnas={['Estado', '', 'Abonado', 'Serie', 'ONU', 'Zona', 'Señal', 'VLAN', 'Modelo', 'Alta']}
            filas={filas}
            vacio="Ninguna ONU coincide con esos filtros."
            renderFila={(o) => {
              const n = nivel(o.rx_power_dbm)
              const e = ESTADOS[o.onu_estado] ?? { label: o.onu_estado, color: 'gris' }
              return (
                <tr key={o.onu_id} className="text-slate-300">
                  <td className="px-3 py-2">
                    <Badge color={e.color}>{e.label}</Badge>
                  </td>
                  <td className="px-3 py-2">
                    <Link
                      to={`/onus/${o.onu_id}`}
                      className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs text-sky-300 hover:bg-sky-500/20"
                    >
                      <Eye size={12} /> Ver
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {o.client_id ? (
                      <Link to={`/clientes/${o.client_id}`} className="text-slate-100 hover:text-sky-300">
                        {o.cliente}
                      </Link>
                    ) : (
                      <span className="text-slate-400">
                        {o.nombre_en_la_olt ?? '—'} <Badge color="azul">sin ficha</Badge>
                      </span>
                    )}
                    {o.direccion && (
                      <span className="block text-[11px] text-slate-600">{o.direccion}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{o.sn}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">
                    {o.olt_numero ? `${o.olt_numero} · ` : ''}
                    {o.olt}
                    <span className="block font-mono text-[11px] text-slate-600">{o.ruta_onu}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{o.zona ?? '—'}</td>
                  <td className={`px-3 py-2 text-xs ${o.senal_baja ? 'text-rose-300' : ''}`}>
                    <span className="flex items-center gap-1.5">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${n.punto}`} />
                      {dbm(o.rx_power_dbm)}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{o.vlan ?? '—'}</td>
                  <td className="px-3 py-2 text-xs">{o.modelo ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {o.autorizada_at ?? '—'}
                  </td>
                </tr>
              )
            }}
          />
        )}
      </Card>

      <p className="text-[11px] leading-snug text-slate-500">
        La VLAN, el modelo y la caja se guardan al dar de alta o al importar. Los de las ONUs que
        ya estaban antes de la migración 44 aparecen vacíos hasta que se las resincronice desde su
        ficha: preferimos el hueco a inventar un dato que nadie leyó del equipo.
      </p>
    </div>
  )
}

function Filtro({ label, valor, onChange, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-500">{label}</span>
      <Select value={valor} onChange={(e) => onChange(e.target.value)}>
        <option value="">Todas</option>
        {children}
      </Select>
    </label>
  )
}
