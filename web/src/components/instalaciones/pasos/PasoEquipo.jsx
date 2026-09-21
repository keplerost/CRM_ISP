import { useState } from 'react'
import { HardDrive, Save } from 'lucide-react'
import { supabase } from '../../../lib/supabaseClient'
import { TECNOLOGIAS, leerEtiqueta, normalizarMac } from '../../../lib/instalaciones'
import EscanerCodigo from '../EscanerCodigo'
import { Aviso, Button, Field, Input, Select } from '../../ui'

/**
 * Paso 1 — qué equipo se está dejando puesto.
 *
 * La serie es el número con el que la OLT identifica a la ONT y la MAC el que
 * usa el router para la radio: sin uno de los dos, ningún paso posterior tiene
 * a qué preguntarle. Por eso es lo primero y por eso se escanea: una serie de
 * doce caracteres copiada a mano desde una escalera falla más seguido de lo que
 * cualquiera admite, y el síntoma —"el equipo no aparece", sea la ONT en la OLT
 * o el CPE en el registro del router— no se parece en nada a la causa.
 */
export default function PasoEquipo({ orden, onError, onGuardado }) {
  const esFibra = orden.tecnologia !== 'wireless'

  const [form, setForm] = useState({
    equipo_tipo: orden.equipo_tipo ?? (esFibra ? 'ont' : 'cpe'),
    equipo_modelo: orden.equipo_modelo ?? '',
    equipo_sn: orden.equipo_sn ?? '',
    equipo_mac: orden.equipo_mac ?? '',
    equipo_origen: orden.equipo_origen ?? 'manual',
  })
  const [guardando, setGuardando] = useState(false)
  const [leido, setLeido] = useState(null)

  const set = (campo) => (e) =>
    setForm((f) => ({ ...f, [campo]: e.target.value, equipo_origen: 'manual' }))

  function escaneado(texto) {
    const { sn, mac } = leerEtiqueta(texto)
    setLeido(texto)

    if (!sn && !mac) {
      return onError?.(
        Object.assign(new Error('El código escaneado no parece una serie ni una MAC'), {
          hint: `Se leyó: ${texto.slice(0, 60)}`,
          detalle: texto,
        }),
      )
    }

    onError?.(null)
    setForm((f) => ({
      ...f,
      equipo_sn: sn ?? f.equipo_sn,
      equipo_mac: mac ?? f.equipo_mac,
      equipo_origen: 'qr',
    }))
  }

  async function guardar() {
    const mac = form.equipo_mac ? normalizarMac(form.equipo_mac) : null
    if (form.equipo_mac && !mac) {
      return onError?.(new Error('La MAC tiene que tener 12 dígitos hexadecimales'))
    }
    if (!form.equipo_sn.trim() && !mac) {
      return onError?.(new Error(`Falta la serie o la MAC de la ${TECNOLOGIAS[orden.tecnologia ?? 'ftth'].equipo}`))
    }

    setGuardando(true)
    onError?.(null)

    try {
      const { error } = await supabase
        .from('instalaciones')
        .update({
          equipo_tipo: form.equipo_tipo,
          equipo_modelo: form.equipo_modelo.trim() || null,
          equipo_sn: form.equipo_sn.trim().toUpperCase() || null,
          equipo_mac: mac,
          equipo_origen: form.equipo_origen,
          // Entrar al asistente no alcanza para decir que el trabajo empezó;
          // haber leído el equipo, sí: el técnico está en el domicilio con el
          // aparato en la mano.
          estado: orden.estado === 'agendada' ? 'en_curso' : orden.estado,
          paso: Math.max(Number(orden.paso ?? 0), 1),
        })
        .eq('id', orden.id)

      if (error) {
        throw error.code === '23505'
          ? Object.assign(
              new Error(`La serie ${form.equipo_sn.toUpperCase()} ya está usada en otra instalación`),
              { hint: 'Es un equipo que ya se instaló en otro domicilio. Verificá la etiqueta.' },
            )
          : error
      }

      await onGuardado?.()
    } catch (err) {
      onError?.(err)
    } finally {
      setGuardando(false)
    }
  }

  return (
    <div className="space-y-4">
      <Aviso>
        Se instala una <b>{TECNOLOGIAS[orden.tecnologia ?? 'ftth'].equipo}</b>. Escaneá el código de
        la etiqueta o escribí los datos a mano.
      </Aviso>

      <EscanerCodigo onLeer={escaneado} />

      {leido && (
        <p className="t-panel px-3 py-2 text-[11px] text-slate-500">
          Leído: <span className="break-all text-slate-300">{leido}</span>
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tipo de equipo">
          <Select value={form.equipo_tipo} onChange={set('equipo_tipo')}>
            <option value="ont">ONT (fibra)</option>
            <option value="cpe">Antena CPE</option>
            <option value="router">Router / hAP</option>
          </Select>
        </Field>

        <Field label="Modelo">
          <Input
            value={form.equipo_modelo}
            onChange={set('equipo_modelo')}
            placeholder={esFibra ? 'HG8310M' : 'LiteBeam 5AC'}
          />
        </Field>

        <Field
          label="Serie (SN)"
          hint={esFibra ? 'Es con lo que la OLT la reconoce' : 'Opcional en radio'}
        >
          <Input
            value={form.equipo_sn}
            onChange={set('equipo_sn')}
            placeholder="HWTC12AB34CD"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </Field>

        <Field
          label="MAC Address"
          hint={esFibra ? 'Opcional en fibra' : 'Es con lo que el router la reconoce'}
        >
          <Input
            value={form.equipo_mac}
            onChange={set('equipo_mac')}
            placeholder="00:1A:2B:3C:4D:5E"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </Field>
      </div>

      <Button
        variante="primario"
        icon={form.equipo_origen === 'qr' ? HardDrive : Save}
        onClick={guardar}
        cargando={guardando}
        className="w-full"
      >
        Guardar equipo y seguir
      </Button>
    </div>
  )
}
