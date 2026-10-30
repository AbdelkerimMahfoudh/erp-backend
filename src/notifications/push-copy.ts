import { classify } from './notification-catalog';

/**
 * What a push says, in the language of the phone it goes to (D225). Composed when it is sent, from the structured
 * notification — never the stored English title. Short and without private figures: a lock screen is read by whoever
 * holds the phone, so a push names the kind of event and the store, and the app shows the rest after sign-in.
 *
 * A push that has been delivered cannot change language. The notification centre re-renders every event in the
 * language the app is set to now.
 */

export type PushLocale = 'en' | 'fr' | 'ar';

const TITLES: Record<string, Record<PushLocale, string>> = {
  'sale.recorded': { en: 'New sale', fr: 'Nouvelle vente', ar: 'بيع جديد' },
  'stock.received': { en: 'Stock received', fr: 'Stock reçu', ar: 'تم استلام مخزون' },
  'discount_approval.requested': { en: 'Price approval needed', fr: 'Validation de prix requise', ar: 'موافقة على سعر مطلوبة' },
  'discount_approval.approved': { en: 'Price approved', fr: 'Prix validé', ar: 'تمت الموافقة على السعر' },
  'discount_approval.rejected': { en: 'Price refused', fr: 'Prix refusé', ar: 'رُفض السعر' },
  'return.requested': { en: 'Return to review', fr: 'Retour à examiner', ar: 'مرتجع للمراجعة' },
  'return.approved': { en: 'Return approved', fr: 'Retour accepté', ar: 'تم قبول المرتجع' },
  'return.rejected': { en: 'Return refused', fr: 'Retour refusé', ar: 'رُفض المرتجع' },
  'return.refund_reported': { en: 'Refund to confirm', fr: 'Remboursement à confirmer', ar: 'استرداد بحاجة إلى تأكيد' },
  'transfer.requested': { en: 'Transfer to approve', fr: 'Transfert à valider', ar: 'نقل بحاجة إلى موافقة' },
  'transfer.shipped': { en: 'Transfer on its way', fr: 'Transfert en route', ar: 'النقل في الطريق' },
  'loan.proposed': { en: 'Loan to accept', fr: 'Prêt à accepter', ar: 'قرض بانتظار القبول' },
  'consignment.requested': { en: 'Consignment to accept', fr: 'Dépôt-vente à accepter', ar: 'أمانة بانتظار القبول' },
  'debt.charged': { en: 'Cash difference recorded', fr: 'Écart de caisse enregistré', ar: 'تم تسجيل فرق في الصندوق' },
  'anomaly.cash_shortfall': { en: 'Cash shortfall', fr: 'Manque en caisse', ar: 'نقص في الصندوق' },
  'staff.role_changed': { en: 'Your role changed', fr: 'Votre rôle a changé', ar: 'تغيّر دورك' },
  'acting_owner.appointed': { en: 'Acting Owner named', fr: 'Propriétaire par intérim désigné', ar: 'تم تعيين مالك بالنيابة' },
  'acting_owner.revoked': { en: 'Acting Owner removed', fr: 'Propriétaire par intérim retiré', ar: 'تم إلغاء المالك بالنيابة' },
};

const BY_CATEGORY: Record<string, Record<PushLocale, string>> = {
  approvals: { en: 'Waiting for your decision', fr: 'En attente de votre décision', ar: 'بانتظار قرارك' },
  sales: { en: 'Sales activity', fr: 'Activité de vente', ar: 'نشاط المبيعات' },
  stock: { en: 'Stock activity', fr: 'Activité du stock', ar: 'نشاط المخزون' },
  money: { en: 'Money activity', fr: 'Activité de caisse', ar: 'نشاط مالي' },
  staff: { en: 'Team change', fr: 'Changement d’équipe', ar: 'تغيير في الفريق' },
  security: { en: 'Security', fr: 'Sécurité', ar: 'الأمان' },
  other: { en: 'New activity', fr: 'Nouvelle activité', ar: 'نشاط جديد' },
};

const OPEN: Record<PushLocale, string> = { en: 'Open Dukan to see it.', fr: 'Ouvrez Dukan pour le voir.', ar: 'افتح تطبيق دكان للاطلاع.' };

export function pushCopy(type: string, locale: PushLocale, storeName: string | null): { title: string; body: string } {
  const title = TITLES[type]?.[locale] ?? BY_CATEGORY[classify(type).category][locale];
  const body = storeName ? `${storeName} · ${OPEN[locale]}` : OPEN[locale];
  return { title, body };
}
