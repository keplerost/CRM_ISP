import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, FileText, Info, Save, X } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { Aviso, Badge, Button, Card, Cargando, Field, Input, Modal, Textarea } from '../ui'

/**
 * Las cláusulas del contrato de adhesión de un prestador.
 *
 * ── Qué se puede cambiar y qué no ──
 *
 * SE PUEDE el TEXTO: cada ISP inscribe su propio modelo ante la ARCOTEL y las
 * redacciones no son idénticas.
 *
 * NO SE PUEDE la ESTRUCTURA: la lista de diez servicios, las seis formas de
 * pago, las causales de terminación y las casillas SI/NO no son redacción, son
 * el formulario que exige el regulador. Cada cláusula dice qué bloque le toca y
 * el sistema lo dibuja.
 *
 * Por eso esto no es un campo de texto libre: editar el texto no puede romper el
 * formulario.
 */

/** Qué agrega cada bloque, dicho en castellano. */
const BLOQUES = {
  servicios: 'la lista de los diez servicios, con el contratado marcado',
  formas_pago: 'las seis formas de pago',
  reclamos: 'los canales de reclamo del prestador',
  causales: 'las causales de terminación de las dos partes',
  paquetes: 'la tabla de paquetes',
  canales_arcotel: 'los canales de atención de la ARCOTEL',
}

const CASILLAS = {
  renovacion_automatica: 'renovación automática',
  permanencia: 'se acoge a la permanencia mínima',
  arbitraje: 'acepta someterse a arbitraje',
  empaquetamiento: 'incluye empaquetamiento',
}

export default function ClausulasContrato({ prestador, onError }) {
  const [clausulas, setClausulas] = useState([])
  const [propias, setPropias] = useState(false)
  const [cargando, setCargando] = useState(true)
  const [guardando, setGuardando] = useState(false)
  const [editando, setEditando] = useState(null)

  const recargar = useCallback(async () => {
    setCargando(true)
    const { data, error } = await supabase
      .from('v_clausulas_prestador')
      .select('*')
      .eq('prestador_id', prestador.id)
      .order('orden')

    if (error) onError?.(error)
    setClausulas(data ?? [])
    setPropias(Boolean(data?.[0]?.es_propia))
    setCargando(false)
  }, [prestador.id, onError])

  useEffect(() => {
    recargar()
  }, [recargar])

  /**
   * Copia el modelo base para que este prestador lo edite.
   *
   * Sin esto, editar tocaría el modelo base y le cambiaría el contrato a los
   * demás prestadores — que en esta instalación son dos.
   */
  async function hacerlasPropias() {
    setGuardando(true)
    onError?.(null)
    try {
      const { error } = await supabase.rpc('copiar_modelo_a_prestador', {
        p_prestador: prestador.id,
      })
      if (error) throw error
      await recargar()
    } catch (e) {
      onError?.(e)
    } finally {
      setGuardando(false)
    }
  }

  async function guardar(cambios) {
    setGuardando(true)
    onError?.(null)
    try {
      const { error } = await supabase
        .from('clausulas_contrato')
        .update({
          numeral: cambios.numeral.trim(),
          titulo: cambios.titulo.trim(),
          texto: cambios.texto.trim() || null,
          cierre: cambios.cierre.trim() || null,
          cierre2: cambios.cierre2.trim() || null,
          numerales: cambios.numerales
            .split('\n\n')
            .map((t) => t.trim())
            .filter(Boolean),
          actualizado_en: new Date().toISOString(),
        })
        .eq('id', cambios.clausula_id)
      if (error) throw error

      setEditando(null)
      await recargar()
    } catch (e) {
      onError?.(e)
    } finally {
      setGuardando(false)
    }
  }

  if (cargando) return <Cargando />

  return (
    <Card
      title="Cláusulas del contrato"
      icon={FileText}
      subtitle={`${clausulas.length} cláusulas · la primera —los comparecientes— la arma el sistema con los datos`}
      actions={
        !propias && (
          <Button variante="primario" icon={Copy} cargando={guardando} onClick={hacerlasPropias}>
            Usar mi propio modelo
          </Button>
        )
      }
    >
      {/*
        Lo primero que hay que saber: si esto es el modelo del sistema o el
        suyo. Sin decirlo, alguien edita creyendo que cambia el propio.
      */}
      {propias ? (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">
          <Check size={14} className="mt-0.5 shrink-0" />
          <span>
            Estas son las cláusulas de <b>{prestador.razon_social}</b>. Lo que edites acá solo
            afecta a sus contratos.
          </span>
        </div>
      ) : (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          <Info size={14} className="mt-0.5 shrink-0" />
          <span>
            Está usando el <b>modelo base</b> que trae el sistema. Si el modelo que inscribió ante
            la ARCOTEL dice otra cosa, tocá <b>Usar mi propio modelo</b>: se copia una para editar
            sin cambiarle el contrato a nadie más.
          </span>
        </div>
      )}

      <Aviso>
        Se edita el texto. Las listas, las tablas y las casillas SÍ/NO las pone el sistema porque
        son el formulario que exige la ARCOTEL — así, cambiar una redacción no puede romperlo.
      </Aviso>

      <ul className="mt-3 space-y-1.5">
        {clausulas.map((c) => (
          <li
            key={c.clausula_id}
            className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-slate-200">
                {c.numeral} — {c.titulo}
              </span>

              {c.bloque && <Badge color="azul">{BLOQUES[c.bloque] ?? c.bloque}</Badge>}
              {c.bloque_final && <Badge color="azul">{BLOQUES[c.bloque_final]}</Badge>}
              {c.condicion && <Badge color="ambar">casilla: {CASILLAS[c.condicion]}</Badge>}
              {c.raya_firma && <Badge color="gris">firma aparte</Badge>}

              <button
                type="button"
                onClick={() =>
                  setEditando({
                    ...c,
                    texto: c.texto ?? '',
                    cierre: c.cierre ?? '',
                    cierre2: c.cierre2 ?? '',
                    numerales: (c.numerales ?? []).join('\n\n'),
                  })
                }
                disabled={!propias}
                title={propias ? 'Editar el texto' : 'Primero tocá "Usar mi propio modelo"'}
                className="ml-auto text-[11px] text-sky-400 hover:text-sky-300 disabled:cursor-not-allowed disabled:text-slate-600"
              >
                Editar
              </button>
            </div>

            {c.texto && (
              <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-500">{c.texto}</p>
            )}
            {!c.texto && c.numerales?.length > 0 && (
              <p className="mt-1 text-[11px] text-slate-500">
                {c.numerales.length} apartado{c.numerales.length > 1 ? 's' : ''} numerado
                {c.numerales.length > 1 ? 's' : ''}
              </p>
            )}
          </li>
        ))}
      </ul>

      <EditorClausula
        clausula={editando}
        guardando={guardando}
        onCerrar={() => setEditando(null)}
        onGuardar={guardar}
      />
    </Card>
  )
}

/** El editor de una cláusula. */
function EditorClausula({ clausula, guardando, onCerrar, onGuardar }) {
  const [form, setForm] = useState(null)

  useEffect(() => {
    setForm(clausula)
  }, [clausula])

  if (!clausula || !form) return null

  const set = (campo) => (e) => setForm((f) => ({ ...f, [campo]: e.target.value }))

  return (
    <Modal abierto titulo={`${clausula.numeral} — ${clausula.titulo}`} onCerrar={onCerrar} ancho="max-w-3xl">
      <div className="space-y-4">
        {/*
          Dónde cae cada campo en el papel. Sin esto hay que guardar, imprimir y
          mirar para entender qué es "cierre" y qué es "cierre 2".
        */}
        <Aviso>
          El orden en que sale impreso: <b>texto</b>
          {clausula.bloque && <> → <i>{BLOQUES[clausula.bloque]}</i></>}
          {clausula.condicion && <> → <i>casilla {CASILLAS[clausula.condicion]}</i></>}
          {clausula.numerales?.length > 0 && <> → <b>apartados</b></>}
          {' '}→ <b>cierre</b>
          {clausula.bloque_final && <> → <i>{BLOQUES[clausula.bloque_final]}</i></>}
          {clausula.cierre2 && <> → <b>cierre 2</b></>}
        </Aviso>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Numeral" hint="Como se imprime">
            <Input value={form.numeral} onChange={set('numeral')} />
          </Field>
          <Field label="Título" className="sm:col-span-2">
            <Input value={form.titulo} onChange={set('titulo')} />
          </Field>
        </div>

        <Field
          label="Texto"
          hint="Acepta {{vigencia}}, {{permanencia_ofrecida}} y {{empresa}}: se reemplazan al imprimir"
        >
          <Textarea rows={6} value={form.texto} onChange={set('texto')} />
        </Field>

        <Field
          label="Apartados numerados"
          hint="Uno por bloque, separados por una línea en blanco (7.1, 7.2…)"
        >
          <Textarea rows={4} value={form.numerales} onChange={set('numerales')} />
        </Field>

        <Field label="Cierre" hint="El párrafo que va después del bloque">
          <Textarea rows={4} value={form.cierre} onChange={set('cierre')} />
        </Field>

        {(form.cierre2 || clausula.cierre2) && (
          <Field label="Cierre 2" hint="Un segundo párrafo de cierre">
            <Textarea rows={4} value={form.cierre2} onChange={set('cierre2')} />
          </Field>
        )}

        {/*
          El texto es lo que el abonado firma y lo que se inscribió ante el
          regulador: conviene que quien lo cambia sepa lo que está haciendo.
        */}
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            Esto sale impreso en los contratos que firman sus abonados. Tiene que coincidir con el
            modelo que inscribió ante la ARCOTEL.
          </span>
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-800 pt-4">
          <Button type="button" icon={X} onClick={onCerrar}>
            Cancelar
          </Button>
          <Button variante="primario" icon={Save} cargando={guardando} onClick={() => onGuardar(form)}>
            Guardar
          </Button>
        </div>
      </div>
    </Modal>
  )
}
