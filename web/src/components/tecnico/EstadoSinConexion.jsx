import { useEffect, useState } from 'react'
import { CloudOff, HardDriveDownload, ShieldCheck, TriangleAlert } from 'lucide-react'

/**
 * ¿Esta app funciona sin señal, sí o no?
 *
 * ── Por qué hace falta preguntarlo ──
 *
 * El modo sin conexión es invisible mientras hay conexión. Se descubre que no
 * está justo cuando se lo necesita: en una zona rural, con el trabajo por
 * delante y sin forma de averiguar por qué.
 *
 * Pasó de verdad. La app se había instalado en el teléfono y parecía andar,
 * pero el servidor que la publicaba era el de desarrollo, que devuelve la
 * página HTML cuando el navegador pide el service worker. La registración
 * fallaba sin decir nada, y offline no había nada.
 *
 * Esta tarjeta responde esa pregunta desde el teléfono, sin herramientas de
 * desarrollo y sin una computadora al lado.
 *
 * ── Qué mira ──
 *
 * `navigator.serviceWorker.controller` es lo único que importa: significa que
 * hay un service worker CONTROLANDO esta página. Que esté registrado y no
 * controle es el caso de la primera visita —todavía no tomó el control— y por
 * eso se distingue de "no hay ninguno".
 */
export default function EstadoSinConexion() {
  const [estado, setEstado] = useState('midiendo')
  const [guardado, setGuardado] = useState(null)

  useEffect(() => {
    let vivo = true

    async function medir() {
      if (!('serviceWorker' in navigator)) {
        if (vivo) setEstado('no_soportado')
        return
      }
      const reg = await navigator.serviceWorker.getRegistration()
      if (!vivo) return

      if (navigator.serviceWorker.controller) setEstado('listo')
      else if (reg) setEstado('instalando')
      else setEstado('sin_sw')

      // Cuánto ocupa lo guardado. Es el dato que responde "¿esto de verdad
      // bajó algo?" — un service worker registrado con caché vacío se ve igual
      // que uno que funciona, hasta que se corta la señal.
      try {
        const est = await navigator.storage?.estimate?.()
        if (vivo && est?.usage) setGuardado(Math.round(est.usage / 1024 / 1024))
      } catch {
        /* no todos los navegadores lo dan */
      }
    }

    medir()
    // Al tomar el control, `controller` cambia: se vuelve a medir en vez de
    // dejar la tarjeta diciendo "instalando" para siempre.
    navigator.serviceWorker?.addEventListener?.('controllerchange', medir)
    return () => {
      vivo = false
      navigator.serviceWorker?.removeEventListener?.('controllerchange', medir)
    }
  }, [])

  const V = {
    midiendo: { icono: HardDriveDownload, tono: 'campo-tenue', titulo: 'Comprobando…', texto: '' },
    listo: {
      icono: ShieldCheck,
      tono: 'text-emerald-500',
      titulo: 'Funciona sin señal',
      texto: 'La app está guardada en el teléfono. Podés trabajar sin conexión.',
    },
    instalando: {
      icono: HardDriveDownload,
      tono: 'text-sky-500',
      titulo: 'Terminando de guardarse',
      texto: 'Cerrá la app y volvé a abrirla con señal para que termine.',
    },
    sin_sw: {
      icono: CloudOff,
      tono: 'text-amber-500',
      titulo: 'NO funciona sin señal',
      texto:
        'La app no quedó guardada en el teléfono. Suele pasar cuando se abre desde el servidor de desarrollo o por http sin certificado. Avisale a la oficina.',
    },
    no_soportado: {
      icono: TriangleAlert,
      tono: 'text-amber-500',
      titulo: 'Este navegador no lo permite',
      texto: 'Abrila en Safari y agregala a la pantalla de inicio.',
    },
  }[estado]

  return (
    <section className="campo-borde campo-sup rounded-2xl border p-4">
      <div className="flex items-start gap-2.5">
        <V.icono size={18} className={`mt-0.5 shrink-0 ${V.tono}`} />
        <div className="min-w-0">
          <p className={`text-[14px] font-semibold ${V.tono}`}>{V.titulo}</p>
          {V.texto && <p className="campo-suave mt-0.5 text-[12px]">{V.texto}</p>}
          {estado === 'listo' && guardado != null && (
            <p className="campo-tenue mt-1 text-[11px]">{guardado} MB guardados en el teléfono</p>
          )}
        </div>
      </div>
    </section>
  )
}
