import { useEffect, useState } from 'react'
import { Dices, Network, Wand2 } from 'lucide-react'
import { supabase } from '../../../lib/supabaseClient'
import { api } from '../../../lib/apiNetwork'
import { claveSugerida, usuarioSugerido } from '../../../lib/instalaciones'
import { Aviso, Button, Field, Input, Select } from '../../ui'

/**
 * Paso 3 — con qué parámetros queda conectado.
 *
 * Dos caminos, según cómo trabaje el nodo:
 *
 *  - PPPoE: el abonado autentica con usuario y clave, y la IP se la da el
 *    router al conectar. Es lo habitual en fibra.
 *  - IP fija: se le reserva una dirección del pool del nodo contra la MAC del
 *    equipo. Es lo habitual en radio y en clientes que necesitan IP estable.
 *
 * La IP no se escribe a mano nunca. La calcula el middleware cruzando lo que
 * hay en la base con lo que hay en el router, porque "la que sigue" según el
 * cuaderno es la forma más común de dejar a dos abonados con la misma dirección
 * y a los dos con internet intermitente.
 */
export default function PasoRed({ orden, onError, onGuardado }) {
  const [routers, setRouters] = useState([])
  const [pools, setPools] = useState([])
  // Qué segmento le toca según dónde apareció la ONT. Se pregunta una vez al
  // abrir el paso: el técnico está en la calle y no tiene por qué saber qué
  // segmento corresponde a la cuadra donde está parado.
  const [sugerido, setSugerido] = useState(null)

  /**
   * Todos los segmentos entre los que se puede elegir, con su torre.
   *
   * Un ISP con diez torres tiene diez sectores, y el sistema no puede saber
   * frente a cuál está parada la antena del cliente. Lo que sí puede es
   * ofrecer la lista con el nombre del sector, que es como el técnico lo
   * piensa: "este cliente ve la torre de La Maná".
   */
  const [segmentos, setSegmentos] = useState([])
  const [buscandoIp, setBuscandoIp] = useState(false)
  const [aplicando, setAplicando] = useState(false)
  const [resultado, setResultado] = useState(null)

  const [form, setForm] = useState({
    router_id: orden.router_id ?? '',
    tipo_conexion: orden.tipo_conexion ?? 'pppoe',
    tipo_ip: orden.tipo_ip ?? 'fija',
    usuario_ppp: orden.usuario_ppp ?? '',
    clave_ppp: orden.clave_ppp ?? '',
    ip: orden.ip ?? '',
    ipv6: orden.ipv6 ?? '',
    pool: orden.pool ?? '',
    red: orden.red ?? '',
  })

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))
  const esPppoe = form.tipo_conexion === 'pppoe'

  useEffect(() => {
    supabase
      .from('routers_mikrotik')
      .select('id, nombre, ip_host')
      .order('nombre')
      .then(({ data }) => setRouters(data ?? []))
  }, [])

  /**
   * Los pools del router se leen para poder elegir de cuál sacar la dirección.
   * Si el router no contesta no se corta el paso: se puede escribir el nombre
   * del pool a mano y seguir.
   */
  useEffect(() => {
    setPools([])
    if (!form.router_id) return

    let vigente = true
    api.mikrotik
      .pools(form.router_id)
      .then((r) => vigente && setPools(Array.isArray(r) ? r : []))
      .catch(() => {})

    return () => {
      vigente = false
    }
  }, [form.router_id])

  function sugerirCredenciales() {
    setForm((f) => ({
      ...f,
      usuario_ppp: f.usuario_ppp || usuarioSugerido({ nombre: orden.titular, identificacion: orden.cedula }),
      clave_ppp: f.clave_ppp || claveSugerida(),
    }))
  }

  useEffect(() => {
    let vivo = true
    api.instalaciones
      .segmentoSugerido(orden.id)
      .then((r) => vivo && setSugerido(r))
      .catch(() => {})
    api.instalaciones
      .segmentos(orden.id)
      .then((r) => vivo && setSegmentos(r.segmentos ?? []))
      .catch(() => {})
    return () => {
      vivo = false
    }
  }, [orden.id])

  async function pedirIp() {
    if (!form.router_id) return onError?.(new Error('Elegí primero el router del nodo'))

    setBuscandoIp(true)
    onError?.(null)

    try {
      const r = await api.instalaciones.ipLibre(orden.id, {
        router_id: form.router_id,
        pool: form.pool || undefined,
        // Sin pool —una red estática— la dirección sale del CIDR del segmento.
        red: form.pool ? undefined : form.red || undefined,
      })
      setForm((f) => ({ ...f, ip: r.ip }))
      setResultado({ mensaje: `${r.ip} está libre en ${r.origen.valor}.` })
    } catch (err) {
      onError?.(err)
    } finally {
      setBuscandoIp(false)
    }
  }

  async function aplicar() {
    if (!form.router_id) return onError?.(new Error('Falta el router del nodo'))
    if (esPppoe && (!form.usuario_ppp.trim() || !form.clave_ppp.trim())) {
      return onError?.(new Error('Faltan el usuario y la clave PPPoE'))
    }
    if (!esPppoe && form.tipo_ip === 'fija' && !form.ip.trim()) {
      return onError?.(new Error('Falta la IP: usá el botón para tomar la siguiente libre'))
    }

    setAplicando(true)
    onError?.(null)

    try {
      const r = await api.instalaciones.aprovisionar(orden.id, {
        router_id: form.router_id,
        tipo_conexion: form.tipo_conexion,
        tipo_ip: form.tipo_ip,
        usuario_ppp: form.usuario_ppp.trim() || null,
        clave_ppp: form.clave_ppp.trim() || null,
        ip: form.ip.trim() || null,
        ipv6: form.ipv6.trim() || null,
        pool: form.pool.trim() || null,
      })
      setResultado(r)
      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setAplicando(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Router del nodo" hint="De dónde sale el servicio de este sector">
          <Select value={form.router_id} onChange={set('router_id')}>
            <option value="">Elegir…</option>
            {routers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.nombre} ({r.ip_host})
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Tipo de conexión"
          hint={
            /**
             * De dónde salió el valor que está viendo.
             *
             * El tipo de conexión no se decide en la calle: sale del diseño de
             * la red. Pero el técnico tiene que poder distinguir "esto lo
             * definió la oficina" de "esto vino puesto por defecto" — si no,
             * cambia lo que no debe o deja lo que estaba mal.
             */
            orden.tipo_conexion
              ? 'Viene de la ficha del abonado. Cambialo solo si en la casa es otra cosa.'
              : 'La ficha no lo tenía cargado: confirmalo antes de aplicar.'
          }
        >
          <Select value={form.tipo_conexion} onChange={set('tipo_conexion')}>
            <option value="pppoe">PPPoE (usuario y clave)</option>
            <option value="ip">IPoE (IP directa, fija o por DHCP)</option>
            <option value="hotspot">Hotspot</option>
          </Select>
        </Field>
      </div>

      {esPppoe ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Usuario PPPoE">
              <Input
                value={form.usuario_ppp}
                onChange={set('usuario_ppp')}
                autoCapitalize="none"
                spellCheck={false}
                placeholder="jefferson.ona"
              />
            </Field>
            <Field label="Clave PPPoE" hint="Sin caracteres que se confundan al dictarla">
              <Input value={form.clave_ppp} onChange={set('clave_ppp')} spellCheck={false} />
            </Field>
          </div>

          <Button type="button" icon={Dices} onClick={sugerirCredenciales}>
            Proponer usuario y clave
          </Button>

          {/*
            "Fija" NO significa lo mismo acá que en IPoE, y por eso el texto es
            distinto. En PPPoE la dirección se escribe en el `remote-address`
            del secret del abonado: no interviene ninguna MAC. En IPoE es una
            reserva DHCP atada a la MAC del equipo.

            Poner el mismo texto en las dos ramas sería más prolijo y sería
            falso en una de ellas.
          */}
          <Field
            label="Direccionamiento"
            hint="Fija: la dirección se graba en su usuario PPPoE. Dinámica: la reparte el pool del router."
          >
            <Select value={form.tipo_ip} onChange={set('tipo_ip')}>
              <option value="dinamica">Dinámica (del pool del router)</option>
              <option value="fija">Fija (en su usuario PPPoE)</option>
            </Select>
          </Field>
        </div>
      ) : (
        <Field
          label="Direccionamiento"
          hint={
            form.tipo_ip === 'fija'
              ? // Se dice la condición ANTES de aplicar, no en el aviso de
                // después: el técnico está parado en la casa del cliente y ahí
                // todavía puede cargar la MAC.
                'Fija: hace falta la MAC del equipo. Sin ella la IP queda anotada pero el router no la reserva.'
              : 'Dinámica: la dirección la reparte el DHCP del router.'
          }
        >
          <Select value={form.tipo_ip} onChange={set('tipo_ip')}>
            <option value="fija">Fija (reserva DHCP por MAC)</option>
            <option value="dinamica">Dinámica (DHCP)</option>
          </Select>
        </Field>
      )}

      {form.tipo_ip === 'fija' && (
        <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
          {/* --- El segmento que le toca, deducido de dónde apareció la ONT ---
              La cadena es: puerto PON → VLAN del puerto → subred de esa VLAN.
              Cuando se corta, se dice DÓNDE se cortó: un campo vacío no
              distingue "no hay segmento" de "nadie configuró la VLAN de ese
              puerto", y esa diferencia decide si el técnico sigue solo o llama. */}
          {sugerido?.encontrado ? (
            <div className="rounded-lg border border-sky-500/40 bg-sky-500/5 p-3">
              <p className="text-sm font-semibold text-sky-200">
                Le corresponde {sugerido.subred}
              </p>
              <p className="mt-0.5 text-xs leading-snug text-sky-200/80">
                {sugerido.por === 'plan'
                  ? `Por el plan ${sugerido.plan}.`
                  : sugerido.por === 'vlan'
                    ? `Por la VLAN ${sugerido.vlan} que tiene puesta la ONU.`
                    : sugerido.por === 'router'
                      ? // Radioenlace: no hay OLT ni puerto PON de dónde deducirlo.
                        // La frase de fibra acá salía con "puerto PON undefined".
                        `Es la red de este nodo para ${orden.tipo_conexion === 'pppoe' ? 'PPPoE' : 'IP directa'}.`
                      : `La ONT está en el puerto PON ${sugerido.puerto}, que usa la VLAN ${sugerido.vlan}.`}{' '}
                Segmento <span className="font-mono">{sugerido.cidr}</span>
                {sugerido.router ? ` en ${sugerido.router}` : ''}
                {sugerido.pool_router ? ` · pool ${sugerido.pool_router}` : ''}.
              </p>
              {/* De dónde salió el dato. Un plan recuperado de la ONU no es lo
                  mismo que uno cargado en la orden, aunque los dos acierten. */}
              {sugerido.origen?.plan_de_la_onu && (
                <p className="mt-1 text-[11px] leading-snug text-amber-300/80">
                  Ojo: esta orden no tiene plan cargado. El plan se tomó de la ONU
                  ({String(sugerido.origen.plan_de_la_onu)}). Cargáselo a la orden para poder
                  facturarla.
                </p>
              )}
              {/*
                Antes el botón solo aparecía si el segmento tenía POOL, y una red
                estática no lo tiene: el técnico veía el segmento propuesto y no
                podía usarlo, sin ningún error a la vista.

                Ahora se guarda el pool cuando lo hay y el CIDR cuando no: las
                dos cosas sirven para pedir después una dirección libre.
              */}
              {(sugerido.pool_router || sugerido.cidr) &&
                form.pool !== sugerido.pool_router &&
                form.red !== sugerido.cidr && (
                  <Button
                    type="button"
                    variante="primario"
                    className="mt-2"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        pool: sugerido.pool_router ?? '',
                        red: sugerido.pool_router ? '' : sugerido.cidr,
                        router_id: sugerido.router_id ?? f.router_id,
                      }))
                    }
                  >
                    Usar este segmento
                  </Button>
                )}
            </div>
          ) : sugerido?.motivo ? (

            /* Antes acá se dibujaba además un botón por candidata. Con diez
               torres eso llenaba la pantalla y ofrecía la misma elección dos
               veces: el desplegable de abajo ya las lista, con el sector y
               cuánto queda libre, en una sola línea. */
            <Aviso tipo="alerta">
              {sugerido.motivo}. {sugerido.hint}
            </Aviso>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            {/*
              Dos formas de decir de dónde sale la dirección, y el campo cambia
              con ella.

              En un pool del router se elige por nombre; en una red estática no
              hay pool y lo que vale es el bloque. Con un solo campo de "pool",
              el técnico de una red estática lo veía vacío después de apretar
              "usar este segmento" y no entendía si había quedado algo puesto.
            */}
            {/*
              El técnico elige el SECTOR, no escribe un bloque.
              
              Con diez torres, "10.10.10.0/24" no le dice nada a nadie parado en
              una escalera; "Torre La Maná" sí. Por eso el nombre del punto de
              red va primero y el bloque después, y por eso se muestra cuánto
              queda libre: elegir un sector lleno es descubrirlo recién al pedir
              la dirección.
            */}
            <Field
              label="Sector o segmento"
              hint={
                segmentos.length
                  ? `${segmentos.length} para ${orden.tipo_conexion === 'pppoe' ? 'PPPoE' : 'IP directa'}`
                  : 'De dónde sale la dirección'
              }
            >
              {segmentos.length ? (
                <Select
                  value={form.pool || form.red}
                  onChange={(e) => {
                    const elegido = segmentos.find(
                      (x) => (x.pool_router || x.cidr) === e.target.value,
                    )
                    setForm((f) => ({
                      ...f,
                      // Con pool se pide por nombre de pool; sin pool, por bloque.
                      pool: elegido?.pool_router ?? '',
                      red: elegido?.pool_router ? '' : (elegido?.cidr ?? ''),
                      router_id: elegido?.router_id ?? f.router_id,
                      // Al cambiar de sector la dirección anterior ya no sirve.
                      ip: '',
                    }))
                  }}
                >
                  <option value="">Elegir el sector…</option>
                  {segmentos.map((x) => (
                    <option key={x.subred_id} value={x.pool_router || x.cidr}>
                      {x.torre ? `${x.torre} · ` : ''}
                      {x.subred} · {x.cidr}
                      {x.utilizables ? ` (${x.utilizables - x.asignadas} libres)` : ''}
                    </option>
                  ))}
                </Select>
              ) : (
                // Sin ninguno cargado se deja escribir, que es mejor que trabar
                // al técnico esperando que alguien cargue las redes.
                <Input
                  value={form.pool || form.red}
                  onChange={(e) => setForm((f) => ({ ...f, pool: e.target.value, red: '' }))}
                  placeholder="pool-nodo-norte"
                />
              )}
            </Field>

            <Field label="IPv4 asignada">
              <Input value={form.ip} onChange={set('ip')} inputMode="decimal" placeholder="10.20.30.45" />
            </Field>
          </div>

          <Button type="button" icon={Wand2} onClick={pedirIp} cargando={buscandoIp}>
            Tomar la siguiente IP libre
          </Button>

          <Field label="IPv6" hint="Solo si el nodo entrega IPv6">
            <Input value={form.ipv6} onChange={set('ipv6')} spellCheck={false} />
          </Field>
        </div>
      )}

      {!esPppoe && form.tipo_ip === 'fija' && !orden.equipo_mac && (
        <Aviso tipo="alerta">
          Sin la MAC del equipo la reserva no se puede fijar en el router: la dirección queda
          anotada en la instalación pero el equipo va a tomar otra. Volvé al paso 1 y cargala.
        </Aviso>
      )}

      <Button
        variante="primario"
        icon={Network}
        onClick={aplicar}
        cargando={aplicando}
        className="w-full"
      >
        Aprovisionar en el router
      </Button>

      {resultado && (
        <Aviso tipo={resultado.aviso ? 'alerta' : 'info'}>
          {resultado.mensaje ??
            (resultado.aplicado
              ? `Quedó configurado en ${resultado.router}${resultado.actualizado ? ' (se corrigió lo que ya estaba)' : ''}.`
              : 'Los parámetros quedaron guardados en la instalación.')}
          {resultado.aviso && <p className="mt-1 text-xs">{resultado.aviso}</p>}
        </Aviso>
      )}

      {orden.aprovisionado_at && (
        <p className="text-xs text-slate-500">
          Aprovisionado el {new Date(orden.aprovisionado_at).toLocaleString()}
        </p>
      )}
    </div>
  )
}
