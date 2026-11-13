/**
 * Names from earlier versions, with the current name of each.
 *
 * Plain data with no imports: the type generator reads it too, to leave these names out of
 * the generated types. Nothing here is exported from `index.ts`.
 */

type AliasMap = Readonly<Record<string, string>>;

/** Previous name (camelCase) to canonical name (camelCase), in the arguments of a validation by fields. */
export const TRANSFER_PARAM_ALIASES: AliasMap = {
  fecha: 'sendDate',
  monto: 'amount',
  claveRastreo: 'trackingKey',
  referenciaNumerica: 'numericReference',
  emisor: 'senderBank',
  receptor: 'receiverBank',
  cuentaBeneficiaria: 'beneficiaryAccount',
  cuentasCandidatas: 'candidateAccounts',
  receptorParticipante: 'recipientIsBank',
};

/** Previous name (camelCase) to canonical name (camelCase), in the arguments of a validation by image. */
export const OCR_PARAM_ALIASES: AliasMap = {
  cuentaBeneficiaria: 'beneficiaryAccount',
  cuentasCandidatas: 'candidateAccounts',
  bancoEmisor: 'senderBank',
  bancoReceptor: 'receiverBank',
  receptorParticipante: 'recipientIsBank',
};

export const REQUEST_DATA: AliasMap = {
  fecha: 'send_date',
  monto: 'amount',
  clave_rastreo: 'tracking_key',
  referencia_numerica: 'numeric_reference',
  emisor: 'sender_bank',
  receptor: 'receiver_bank',
  cuenta_beneficiaria: 'beneficiary_account',
  cuentas_candidatas: 'candidate_accounts',
  receptor_participante: 'recipient_is_bank',
  banco_emisor: 'sender_bank',
  banco_receptor: 'receiver_bank',
};

export const OCR_RESULT: AliasMap = {
  tipo_comprobante: 'receipt_type',
  clave_rastreo: 'tracking_key',
  referencia_numerica: 'numeric_reference',
  fecha: 'send_date',
  hora: 'time',
  monto: 'amount',
  banco_emisor: 'sender_bank',
  banco_receptor: 'receiver_bank',
  nombre_ordenante: 'sender_name',
  nombre_beneficiario: 'beneficiary_name',
  cuenta_beneficiaria: 'beneficiary_account',
  cuenta_beneficiaria_es_parcial: 'beneficiary_account_is_partial',
  cuenta_beneficiaria_is_masked: 'beneficiary_account_is_masked',
  cuenta_beneficiaria_visible_first: 'beneficiary_account_visible_first',
  cuenta_beneficiaria_visible_last: 'beneficiary_account_visible_last',
  cuenta_beneficiaria_total_length_hint: 'beneficiary_account_total_length_hint',
  cuenta_ordenante: 'sender_account',
  cuenta_ordenante_es_parcial: 'sender_account_is_partial',
  cuenta_ordenante_is_masked: 'sender_account_is_masked',
  cuenta_ordenante_visible_first: 'sender_account_visible_first',
  cuenta_ordenante_visible_last: 'sender_account_visible_last',
  cuenta_ordenante_total_length_hint: 'sender_account_total_length_hint',
  concepto: 'payment_concept',
  otras_cuentas_detectadas: 'other_accounts_detected',
  comprobantes_detectados: 'receipts_detected',
  confianza: 'confidence',
  confianza_por_campo: 'confidence_by_field',
};

export const CONFIDENCE_BY_FIELD: AliasMap = {
  banco_emisor: 'sender_bank',
  banco_receptor: 'receiver_bank',
  cuenta_beneficiaria: 'beneficiary_account',
  cuenta_ordenante: 'sender_account',
  monto: 'amount',
  clave_rastreo: 'tracking_key',
  fecha: 'send_date',
};

export const NORMALIZED_DATA: AliasMap = {
  tipo_comprobante: 'receipt_type',
  clave_rastreo: 'tracking_key',
  referencia_numerica: 'numeric_reference',
  fecha: 'send_date',
  hora: 'time',
  monto: 'amount',
  emisor_code: 'sender_bank_code',
  emisor_name: 'sender_bank_name',
  receptor_code: 'receiver_bank_code',
  receptor_name: 'receiver_bank_name',
  cuenta_beneficiaria: 'beneficiary_account',
  cuenta_beneficiaria_type: 'beneficiary_account_type',
  cuenta_beneficiaria_is_masked: 'beneficiary_account_is_masked',
  cuenta_ordenante: 'sender_account',
  cuenta_ordenante_is_masked: 'sender_account_is_masked',
  cuenta_ordenante_visible_first: 'sender_account_visible_first',
  cuenta_ordenante_visible_last: 'sender_account_visible_last',
  nombre_ordenante: 'sender_name',
  nombre_beneficiario: 'beneficiary_name',
  concepto: 'payment_concept',
  confianza: 'confidence',
};

export const DETECTED_ACCOUNT: AliasMap = {
  digitos: 'digits',
  etiqueta: 'label',
  banco: 'bank_name',
};

export const SUMMARY_ATTRIBUTES: AliasMap = { referencia_numerica: 'numeric_reference' };

export const FINANCE_SUMMARY: AliasMap = {
  top_banks_receptor: 'top_banks_receiver',
  top_banks_emisor: 'top_banks_sender',
  folio: 'statement_folio',
};

export const COUNTERPARTY: AliasMap = { cuenta: 'account_number', banco: 'bank_name' };

/** The maps of the names found in responses, each one with its parent object. */
export const RESPONSE_ALIAS_MAPS: readonly AliasMap[] = [
  REQUEST_DATA,
  OCR_RESULT,
  CONFIDENCE_BY_FIELD,
  NORMALIZED_DATA,
  DETECTED_ACCOUNT,
  SUMMARY_ATTRIBUTES,
  FINANCE_SUMMARY,
  COUNTERPARTY,
];

/** Every name from an earlier version, sorted. */
export function legacyNames(): string[] {
  const maps: AliasMap[] = [TRANSFER_PARAM_ALIASES, OCR_PARAM_ALIASES, ...RESPONSE_ALIAS_MAPS];
  return [...new Set(maps.flatMap((map) => Object.keys(map)))].sort();
}
