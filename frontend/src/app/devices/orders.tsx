import {
  CheckCircle2, Clock, Package, Plus, RefreshCw, RotateCw,
  ShoppingCart, Trash2, Truck, X,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Linking, Modal,
  Platform, Pressable, ScrollView, StyleSheet, Text, TextInput,
  View, useWindowDimensions,
} from 'react-native';
import { Card } from '@/components/ui/card';
import { KpiCard } from '@/components/ui/kpi-card';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { useAuth } from '@/contexts/auth-context';
import { useTheme } from '@/hooks/use-theme';
import { api, type CatalogItem, type SmClinic, type UnifiedOrder } from '@/lib/api';
import type { Tone } from '@/components/ui/status-pill';

// ── Types ──────────────────────────────────────────────────────────────────

type CartItem = { item: CatalogItem; qty: number };

// ── Helpers ────────────────────────────────────────────────────────────────

const ORDER_STATUS_TONE: Record<string, Tone> = {
  Draft: 'muted', Requested: 'muted', Pending: 'warning', Created: 'info',
  'On Hold': 'warning', Processing: 'info', Shipped: 'info', Dispatched: 'info',
  Updated: 'info', Delivered: 'primary', Confirmed: 'primary',
  Active: 'success', Activated: 'success', Returned: 'warning',
  Rerouted: 'warning', Cancelled: 'critical', Unknown: 'muted',
};
function orderTone(status: string): Tone { return ORDER_STATUS_TONE[status] ?? 'muted'; }

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diffD = Math.round((Date.now() - d.getTime()) / 86_400_000);
  if (diffD === 0) return 'Today';
  if (diffD === 1) return 'Yesterday';
  if (diffD < 30)  return `${diffD}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

// ── Tab bar ────────────────────────────────────────────────────────────────

function TabBar({ active, onChange }: {
  active: 'orders' | 'catalog';
  onChange: (t: 'orders' | 'catalog') => void;
}) {
  const colors = useTheme();
  return (
    <View style={[s.tabBar, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {(['orders', 'catalog'] as const).map((tab) => (
        <Pressable
          key={tab}
          onPress={() => onChange(tab)}
          style={[s.tabItem, active === tab && { backgroundColor: colors.primary }]}>
          <Text style={[s.tabText, { color: active === tab ? '#fff' : colors.textSecondary }]}>
            {tab === 'orders' ? 'Orders' : 'Catalog'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// ── Pipeline bar ───────────────────────────────────────────────────────────

const PIPELINE_STAGES = ['Pending', 'Processing', 'Shipped', 'Delivered', 'Activated'];

function PipelineBar({ orders }: { orders: UnifiedOrder[] }) {
  const colors = useTheme();
  const stageCounts = PIPELINE_STAGES.map((stage) => ({
    stage, count: orders.filter((o) => o.status === stage).length,
  }));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={s.pipeline}>
        {stageCounts.map(({ stage, count }, i) => (
          <View key={stage} style={s.pipelineItem}>
            <View style={[s.pipelineNode, {
              backgroundColor: count > 0 ? colors.primary + '18' : colors.muted,
              borderColor: count > 0 ? colors.primary + '40' : colors.border,
            }]}>
              <Text style={[s.pipelineCount, { color: count > 0 ? colors.primary : colors.textSecondary }]}>
                {count}
              </Text>
            </View>
            <Text style={[s.pipelineLabel, { color: colors.textSecondary }]}>{stage}</Text>
            {i < stageCounts.length - 1 && (
              <Text style={[s.pipelineArrow, { color: colors.border }]}>→</Text>
            )}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

// ── Filter select ─────────────────────────────────────────────────────────

function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string;
  options: { label: string; value: string }[];
  onChange: (v: string) => void;
}) {
  const colors = useTheme();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value)?.label ?? label;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={[s.filterBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[s.filterBtnText, { color: value ? colors.text : colors.textSecondary }]} numberOfLines={1}>
          {current}
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: 10 }}>▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={s.modalOverlay} onPress={() => setOpen(false)}>
          <View style={[s.pickerCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {[{ label, value: '' }, ...options].map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => { onChange(opt.value); setOpen(false); }}
                style={[s.pickerOpt, opt.value === value && { backgroundColor: colors.primary + '14' }]}>
                <Text style={[s.pickerOptText, { color: opt.value === value ? colors.primary : colors.text }]}>
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

// ── Orders table ───────────────────────────────────────────────────────────

const ORDER_FIXED_W = 100 + 110 + 80 + 90 + 90;

function OrdersTable({ orders }: { orders: UnifiedOrder[] }) {
  const colors = useTheme();
  const { width: screenWidth } = useWindowDimensions();
  const devicesColW = Math.max(160, (screenWidth - 32) - ORDER_FIXED_W);
  const tableWidth  = Math.max(devicesColW + ORDER_FIXED_W, screenWidth - 32);

  if (orders.length === 0) {
    return (
      <View style={[s.emptyBox, { borderColor: colors.border }]}>
        <Package size={28} color={colors.textSecondary} strokeWidth={1.5} />
        <Text style={[s.emptyText, { color: colors.textSecondary }]}>No orders match filters</Text>
      </View>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={{ width: tableWidth, minWidth: tableWidth }}>
        <View style={[s.tableHeader, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
          {(['ORDER #', 'DEVICES / RECIPIENT', 'SOURCE', 'TRACKING', 'STATUS', 'DATE'] as const).map((h, i) => (
            <Text key={h} style={[s.th, { width: [100, devicesColW, 110, 80, 90, 90][i], color: colors.textSecondary }]}>{h}</Text>
          ))}
        </View>
        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 500 }}>
          {orders.map((o, i) => (
            <View key={o.id} style={[
              s.tableRow, { borderBottomColor: colors.border },
              i % 2 === 0 && { backgroundColor: colors.background },
            ]}>
              <View style={{ width: 100, paddingRight: 6 }}>
                <Text style={[s.orderNum, { color: colors.text }]} numberOfLines={1}>{o.orderNumber}</Text>
                {o.fulfilled && (
                  <View style={s.fulfilledRow}>
                    <CheckCircle2 size={9} color={colors.success} />
                    <Text style={[s.fulfilledText, { color: colors.success }]}>Fulfilled</Text>
                  </View>
                )}
              </View>
              <View style={{ width: devicesColW, paddingRight: 8 }}>
                <Text style={[s.devicesList, { color: colors.text }]} numberOfLines={2}>
                  {o.devices.length > 0 ? o.devices.join(', ') : '—'}
                </Text>
                {(o.patientName || o.clinicName) && (
                  <Text style={[s.recipientSub, { color: colors.textSecondary }]} numberOfLines={1}>
                    {[o.patientName, o.clinicName].filter(Boolean).join(' · ')}
                  </Text>
                )}
              </View>
              <View style={{ width: 110, justifyContent: 'center' }}>
                <View style={[s.sourcePill, { backgroundColor: o.source === 'Tenovi' ? colors.info + '18' : colors.primary + '18' }]}>
                  <Text style={[s.sourcePillText, { color: o.source === 'Tenovi' ? colors.info : colors.primary }]}>
                    {o.source}
                  </Text>
                </View>
              </View>
              <View style={{ width: 80, justifyContent: 'center' }}>
                {o.trackingLink
                  ? <Pressable onPress={() => Linking.openURL(o.trackingLink!)}>
                      <Text style={[s.trackingLink, { color: colors.primary }]} numberOfLines={1}>Track ↗</Text>
                    </Pressable>
                  : <Text style={[s.tracking, { color: colors.textSecondary }]} numberOfLines={1}>
                      {o.tracking ? (o.tracking.length > 12 ? o.tracking.slice(-10) : o.tracking) : '—'}
                    </Text>
                }
                {o.carrier && <Text style={[s.carrier, { color: colors.textSecondary }]} numberOfLines={1}>{o.carrier}</Text>}
              </View>
              <View style={{ width: 90, justifyContent: 'center' }}>
                <StatusPill tone={orderTone(o.status)}>{o.status}</StatusPill>
              </View>
              <View style={{ width: 90, justifyContent: 'center' }}>
                <Text style={[s.dateText, { color: colors.textSecondary }]}>{fmtDate(o.createdAt)}</Text>
                {o.shippedOn && <Text style={[s.shippedText, { color: colors.textSecondary }]}>Shipped {fmtDate(o.shippedOn)}</Text>}
              </View>
            </View>
          ))}
        </ScrollView>
      </View>
    </ScrollView>
  );
}

// ── Catalog card ───────────────────────────────────────────────────────────

function CatalogCard({ item, cartQty, onAdd, onUpdateQty }: {
  item: CatalogItem;
  cartQty: number;
  onAdd: () => void;
  onUpdateQty: (qty: number) => void;
}) {
  const colors = useTheme();
  const isOut = !item.inStock;
  const inCart = cartQty > 0;

  return (
    <View style={[s.catalogCard, { backgroundColor: colors.card, borderColor: inCart ? colors.primary + '60' : colors.border }]}>
      {item.imageUrl
        ? <Image source={{ uri: item.imageUrl }} style={s.catalogImg} resizeMode="contain" />
        : <View style={[s.catalogImgPlaceholder, { backgroundColor: colors.background }]}>
            <Package size={36} color={colors.textSecondary} strokeWidth={1.2} />
          </View>
      }
      <View style={[s.vendorBadge, { backgroundColor: item.vendor === 'Tenovi' ? colors.info + '18' : colors.primary + '18' }]}>
        <Text style={[s.vendorText, { color: item.vendor === 'Tenovi' ? colors.info : colors.primary }]}>
          {item.vendor}
        </Text>
      </View>
      <Text style={[s.catalogName, { color: colors.text }]} numberOfLines={2}>{item.name}</Text>
      <Text style={[s.catalogSku, { color: colors.textSecondary }]} numberOfLines={1}>SKU: {item.sku}</Text>
      {item.vendor === 'Tenovi' && (item.upFrontCost || item.monthlyCost) && (
        <View style={s.pricingRow}>
          {item.upFrontCost && <Text style={[s.priceTag, { color: colors.text }]}>${item.upFrontCost}</Text>}
          {item.monthlyCost && <Text style={[s.priceSub, { color: colors.textSecondary }]}>${item.monthlyCost}/mo</Text>}
        </View>
      )}
      <View style={[s.stockPill, { backgroundColor: isOut ? colors.critical + '14' : colors.success + '14' }]}>
        <Text style={[s.stockText, { color: isOut ? colors.critical : colors.success }]}>
          {isOut ? 'Out of Stock' : 'In Stock'}
        </Text>
      </View>

      {/* Add to cart / qty stepper */}
      {inCart ? (
        <View style={[s.cartStepper, { borderColor: colors.primary + '40', backgroundColor: colors.primary + '08' }]}>
          <Pressable
            onPress={() => onUpdateQty(cartQty - 1)}
            style={[s.cartStepBtn, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={[s.cartStepBtnText, { color: colors.text }]}>{cartQty === 1 ? '🗑' : '−'}</Text>
          </Pressable>
          <Text style={[s.cartStepCount, { color: colors.primary }]}>{cartQty}</Text>
          <Pressable
            onPress={() => onUpdateQty(Math.min(cartQty + 1, item.maxQty))}
            disabled={cartQty >= item.maxQty}
            style={[s.cartStepBtn, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <Text style={[s.cartStepBtnText, { color: cartQty >= item.maxQty ? colors.textSecondary : colors.text }]}>+</Text>
          </Pressable>
        </View>
      ) : (
        <Pressable
          onPress={onAdd}
          disabled={isOut}
          style={[s.addToCartBtn, { backgroundColor: isOut ? colors.muted : colors.primary }]}>
          <ShoppingCart size={13} color={isOut ? colors.textSecondary : '#fff'} />
          <Text style={[s.addToCartBtnText, { color: isOut ? colors.textSecondary : '#fff' }]}>
            Add to Cart
          </Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Cart sheet ─────────────────────────────────────────────────────────────

function CartSheet({ cart, onUpdateQty, onCheckout, onClose }: {
  cart: CartItem[];
  onUpdateQty: (itemId: string, qty: number) => void;
  onCheckout: () => void;
  onClose: () => void;
}) {
  const colors = useTheme();
  const totalItems = cart.reduce((sum, c) => sum + c.qty, 0);
  const smCount    = cart.filter((c) => c.item.vendor === 'SmartMeter').reduce((s, c) => s + c.qty, 0);
  const tenoviCount = cart.filter((c) => c.item.vendor === 'Tenovi').reduce((s, c) => s + c.qty, 0);

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}>

          {/* Header */}
          <View style={[s.sheetHeader, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.sheetTitle, { color: colors.text }]}>Cart</Text>
              <Text style={[s.sheetSub, { color: colors.textSecondary }]}>
                {totalItems} item{totalItems !== 1 ? 's' : ''}
                {smCount > 0 && tenoviCount > 0 && ` · ${smCount} SmartMeter, ${tenoviCount} Tenovi`}
              </Text>
            </View>
            <Pressable onPress={onClose} style={[s.closeBtn, { backgroundColor: colors.muted }]}>
              <X size={16} color={colors.textSecondary} />
            </Pressable>
          </View>

          {cart.length === 0 ? (
            <View style={[s.center, { paddingVertical: 60 }]}>
              <ShoppingCart size={40} color={colors.textSecondary} strokeWidth={1.2} />
              <Text style={[s.emptyText, { color: colors.textSecondary }]}>Your cart is empty</Text>
            </View>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
              {cart.map(({ item, qty }) => (
                <View key={item.id} style={[s.cartRow, { borderBottomColor: colors.border }]}>
                  {/* Thumbnail */}
                  {item.imageUrl
                    ? <Image source={{ uri: item.imageUrl }} style={s.cartThumb} resizeMode="contain" />
                    : <View style={[s.cartThumbPlaceholder, { backgroundColor: colors.background }]}>
                        <Package size={20} color={colors.textSecondary} strokeWidth={1.5} />
                      </View>
                  }
                  {/* Info */}
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[s.cartItemName, { color: colors.text }]} numberOfLines={2}>{item.name}</Text>
                    <View style={s.cartItemMeta}>
                      <View style={[s.vendorBadgeSmall, { backgroundColor: item.vendor === 'Tenovi' ? colors.info + '18' : colors.primary + '18' }]}>
                        <Text style={[s.vendorTextSmall, { color: item.vendor === 'Tenovi' ? colors.info : colors.primary }]}>{item.vendor}</Text>
                      </View>
                      <Text style={[s.cartItemSku, { color: colors.textSecondary }]}>{item.sku}</Text>
                    </View>
                    {item.vendor === 'Tenovi' && item.upFrontCost && (
                      <Text style={[s.cartItemPrice, { color: colors.textSecondary }]}>
                        ${item.upFrontCost}{item.monthlyCost ? ` · $${item.monthlyCost}/mo` : ''} × {qty}
                      </Text>
                    )}
                  </View>
                  {/* Qty + remove */}
                  <View style={s.cartQtyCol}>
                    <View style={[s.cartQtyStepper, { borderColor: colors.border }]}>
                      <Pressable
                        onPress={() => onUpdateQty(item.id, qty - 1)}
                        style={s.cartQtyBtn}>
                        <Text style={[s.cartQtyBtnTxt, { color: colors.text }]}>{qty === 1 ? '−' : '−'}</Text>
                      </Pressable>
                      <Text style={[s.cartQtyNum, { color: colors.text }]}>{qty}</Text>
                      <Pressable
                        onPress={() => onUpdateQty(item.id, qty + 1)}
                        disabled={qty >= item.maxQty}
                        style={s.cartQtyBtn}>
                        <Text style={[s.cartQtyBtnTxt, { color: qty >= item.maxQty ? colors.textSecondary : colors.text }]}>+</Text>
                      </Pressable>
                    </View>
                    <Pressable onPress={() => onUpdateQty(item.id, 0)} style={s.removeBtn}>
                      <Trash2 size={14} color={colors.critical} />
                    </Pressable>
                  </View>
                </View>
              ))}
              <View style={{ height: 16 }} />
            </ScrollView>
          )}

          {/* Footer */}
          {cart.length > 0 && (
            <View style={[s.sheetFooter, { borderTopColor: colors.border }]}>
              <View style={{ gap: 2 }}>
                <Text style={[s.footerTotal, { color: colors.text }]}>
                  {totalItems} item{totalItems !== 1 ? 's' : ''} in cart
                </Text>
                {smCount > 0 && tenoviCount > 0 && (
                  <Text style={[s.footerSub, { color: colors.textSecondary }]}>
                    SmartMeter & Tenovi orders placed separately
                  </Text>
                )}
              </View>
              <Pressable
                onPress={onCheckout}
                style={[s.checkoutBtn, { backgroundColor: colors.primary }]}>
                <ShoppingCart size={15} color="#fff" />
                <Text style={s.checkoutBtnText}>Checkout</Text>
              </Pressable>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Checkout sheet ─────────────────────────────────────────────────────────

const SM_SHIPPING_METHODS = [
  { label: 'Standard',               value: 'MAIL' },
  { label: 'Standard + Signature',   value: 'MAIL_SIG' },
  { label: 'Overnight',              value: 'UP2' },
  { label: 'Overnight + Signature',  value: 'UP2_SIG' },
];

const US_STATES = [
  { label: 'Alabama', value: 'AL' },       { label: 'Alaska', value: 'AK' },
  { label: 'Arizona', value: 'AZ' },       { label: 'Arkansas', value: 'AR' },
  { label: 'California', value: 'CA' },    { label: 'Colorado', value: 'CO' },
  { label: 'Connecticut', value: 'CT' },   { label: 'Delaware', value: 'DE' },
  { label: 'D.C.', value: 'DC' },          { label: 'Florida', value: 'FL' },
  { label: 'Georgia', value: 'GA' },       { label: 'Hawaii', value: 'HI' },
  { label: 'Idaho', value: 'ID' },         { label: 'Illinois', value: 'IL' },
  { label: 'Indiana', value: 'IN' },       { label: 'Iowa', value: 'IA' },
  { label: 'Kansas', value: 'KS' },        { label: 'Kentucky', value: 'KY' },
  { label: 'Louisiana', value: 'LA' },     { label: 'Maine', value: 'ME' },
  { label: 'Maryland', value: 'MD' },      { label: 'Massachusetts', value: 'MA' },
  { label: 'Michigan', value: 'MI' },      { label: 'Minnesota', value: 'MN' },
  { label: 'Mississippi', value: 'MS' },   { label: 'Missouri', value: 'MO' },
  { label: 'Montana', value: 'MT' },       { label: 'Nebraska', value: 'NE' },
  { label: 'Nevada', value: 'NV' },        { label: 'New Hampshire', value: 'NH' },
  { label: 'New Jersey', value: 'NJ' },    { label: 'New Mexico', value: 'NM' },
  { label: 'New York', value: 'NY' },      { label: 'North Carolina', value: 'NC' },
  { label: 'North Dakota', value: 'ND' },  { label: 'Ohio', value: 'OH' },
  { label: 'Oklahoma', value: 'OK' },      { label: 'Oregon', value: 'OR' },
  { label: 'Pennsylvania', value: 'PA' },  { label: 'Rhode Island', value: 'RI' },
  { label: 'South Carolina', value: 'SC' },{ label: 'South Dakota', value: 'SD' },
  { label: 'Tennessee', value: 'TN' },     { label: 'Texas', value: 'TX' },
  { label: 'Utah', value: 'UT' },          { label: 'Vermont', value: 'VT' },
  { label: 'Virginia', value: 'VA' },      { label: 'Washington', value: 'WA' },
  { label: 'West Virginia', value: 'WV' }, { label: 'Wisconsin', value: 'WI' },
  { label: 'Wyoming', value: 'WY' },
];

function Field({ label, value, onChange, placeholder, required, keyboardType }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; required?: boolean;
  keyboardType?: 'default' | 'phone-pad' | 'numeric';
}) {
  const colors = useTheme();
  return (
    <View style={s.fieldWrap}>
      <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>
        {label}{required && <Text style={{ color: colors.critical }}> *</Text>}
      </Text>
      <TextInput
        value={value} onChangeText={onChange}
        placeholder={placeholder ?? label} placeholderTextColor={colors.textSecondary}
        keyboardType={keyboardType ?? 'default'}
        style={[s.fieldInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
      />
    </View>
  );
}

function SelectField({ label, displayValue, onPress, required }: {
  label: string; displayValue: string; onPress: () => void; required?: boolean;
}) {
  const colors = useTheme();
  return (
    <View style={s.fieldWrap}>
      <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>
        {label}{required && <Text style={{ color: colors.critical }}> *</Text>}
      </Text>
      <Pressable
        onPress={onPress}
        style={[s.fieldInput, s.selectInput, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <Text style={{ color: displayValue ? colors.text : colors.textSecondary, fontSize: 14, flex: 1 }} numberOfLines={1}>
          {displayValue || `Select ${label}…`}
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: 10 }}>▾</Text>
      </Pressable>
    </View>
  );
}

function PickerModal<T extends string>({ visible, title, options, value, onSelect, onClose }: {
  visible: boolean; title: string;
  options: Array<{ label: string; value: T }>;
  value: T; onSelect: (v: T) => void; onClose: () => void;
}) {
  const colors = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[s.pickerSheet, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[s.sheetHeader, { borderBottomColor: colors.border }]}>
          <Text style={[s.sheetTitle, { color: colors.text }]}>{title}</Text>
          <Pressable onPress={onClose} style={[s.closeBtn, { backgroundColor: colors.muted }]}>
            <X size={16} color={colors.textSecondary} />
          </Pressable>
        </View>
        <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
          {options.map((opt) => (
            <Pressable
              key={opt.value}
              onPress={() => { onSelect(opt.value); onClose(); }}
              style={[
                s.pickerSheetOpt, { borderBottomColor: colors.border },
                opt.value === value && { backgroundColor: colors.primary + '12' },
              ]}>
              <Text style={[s.pickerSheetOptText, { color: opt.value === value ? colors.primary : colors.text }]}>
                {opt.label}
              </Text>
              {opt.value === value && <Text style={{ color: colors.primary, fontSize: 16 }}>✓</Text>}
            </Pressable>
          ))}
          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    </Modal>
  );
}

function CheckoutSheet({ cart, smClinics, token, onClose, onSuccess }: {
  cart: CartItem[];
  smClinics: SmClinic[];
  token: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const colors = useTheme();

  const [firstName, setFirstName]     = useState('');
  const [lastName, setLastName]       = useState('');
  const [phone, setPhone]             = useState('');
  const [address1, setAddress1]       = useState('');
  const [address2, setAddress2]       = useState('');
  const [city, setCity]               = useState('');
  const [stateCode, setStateCode]     = useState('');
  const [postalCode, setPostalCode]   = useState('');
  const [country, setCountry]         = useState('United States');
  const [shippingMethod, setShipping] = useState('MAIL');
  const [poNumber, setPo]             = useState('');
  const [clinicId, setClinicId]       = useState(smClinics[0]?.id ?? '');

  const [showState, setShowState]     = useState(false);
  const [showShipping, setShowShipping] = useState(false);
  const [showClinic, setShowClinic]   = useState(false);

  const [submitting, setSubmitting]   = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [progress, setProgress]       = useState('');

  const smItems     = cart.filter((c) => c.item.vendor === 'SmartMeter');
  const tenoviItems = cart.filter((c) => c.item.vendor === 'Tenovi');
  const totalItems  = cart.reduce((n, c) => n + c.qty, 0);

  const customerName = lastName.trim()
    ? `${firstName.trim()} ${lastName.trim()}`
    : firstName.trim();

  const submit = async () => {
    if (!firstName.trim() || !address1.trim() || !city.trim() || !stateCode || !postalCode.trim()) {
      setSubmitError('Please fill in all required fields.');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const errors: string[] = [];

    // ── SmartMeter: one order with all lines ────────────────────────────────
    if (smItems.length > 0) {
      const cid = clinicId || smClinics[0]?.id;
      if (!cid) {
        errors.push('No SmartMeter clinic configured.');
      } else {
        setProgress('Placing SmartMeter order…');
        try {
          await api.placeSmartMeterDeviceOrder(token, {
            clinicId: cid,
            order: {
              order_number:    `RPM-${Date.now()}`,
              customer_name:   customerName,
              address1:        address1.trim(),
              address2:        address2.trim() || undefined,
              city:            city.trim(),
              state:           stateCode,
              zipcode:         postalCode.trim(),
              country:         country.trim() || 'United States',
              shipping_method: shippingMethod,
              po_number:       poNumber.trim() || undefined,
            },
            lines: smItems.map((c) => ({ sku: c.item.sku, quantity: c.qty })),
          });
        } catch (err: any) {
          errors.push(`SmartMeter: ${err?.message ?? 'order failed'}`);
        }
      }
    }

    // ── Tenovi: one fulfillment call per unit ───────────────────────────────
    const fullAddress = address2.trim()
      ? `${address1.trim()} ${address2.trim()}`
      : address1.trim();

    for (const { item, qty } of tenoviItems) {
      for (let i = 0; i < qty; i++) {
        setProgress(`Placing Tenovi order for ${item.name}${qty > 1 ? ` (${i + 1}/${qty})` : ''}…`);
        try {
          await api.placeTenoviDeviceOrder(token, {
            device: {
              name:          item.name,
              hardware_uuid: null,
              fulfillment_request: {
                shipping_name:     customerName,
                shipping_address:  fullAddress,
                shipping_city:     city.trim(),
                shipping_state:    stateCode,
                shipping_zip_code: postalCode.trim(),
              },
            },
            ...(phone.trim() ? { patient: { phone_number: phone.trim(), name: customerName } } : {}),
          });
        } catch (err: any) {
          errors.push(`Tenovi (${item.name}): ${err?.message ?? 'order failed'}`);
        }
      }
    }

    setProgress('');
    setSubmitting(false);

    if (errors.length === 0) {
      onSuccess();
    } else {
      setSubmitError(errors.join('\n'));
    }
  };

  const stateName    = US_STATES.find((s) => s.value === stateCode)?.label ?? '';
  const shippingLbl  = SM_SHIPPING_METHODS.find((m) => m.value === shippingMethod)?.label ?? 'Standard';
  const hasSmItems   = smItems.length > 0;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, justifyContent: 'flex-end' }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <View style={[s.sheet, s.checkoutSheet, { backgroundColor: colors.card, borderColor: colors.border }]}>

          {/* Header */}
          <View style={[s.sheetHeader, { borderBottomColor: colors.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[s.sheetTitle, { color: colors.text }]}>Checkout</Text>
              <Text style={[s.sheetSub, { color: colors.textSecondary }]}>
                {totalItems} item{totalItems !== 1 ? 's' : ''} · {cart.length} device type{cart.length !== 1 ? 's' : ''}
              </Text>
            </View>
            <Pressable onPress={onClose} style={[s.closeBtn, { backgroundColor: colors.muted }]}>
              <X size={16} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }} keyboardShouldPersistTaps="handled">

            {/* Order summary */}
            <View style={[s.orderSummary, { backgroundColor: colors.background, borderColor: colors.border }]}>
              {cart.map(({ item, qty }) => (
                <View key={item.id} style={s.summaryRow}>
                  <View style={[s.vendorBadgeSmall, {
                    backgroundColor: item.vendor === 'Tenovi' ? colors.info + '18' : colors.primary + '18',
                  }]}>
                    <Text style={[s.vendorTextSmall, { color: item.vendor === 'Tenovi' ? colors.info : colors.primary }]}>
                      {item.vendor}
                    </Text>
                  </View>
                  <Text style={[s.summaryItemName, { color: colors.text }]} numberOfLines={1}>{item.name}</Text>
                  <Text style={[s.summaryQty, { color: colors.textSecondary }]}>×{qty}</Text>
                </View>
              ))}
            </View>

            {/* RECIPIENT */}
            <Text style={[s.sectionDivider, { color: colors.textSecondary, borderBottomColor: colors.border }]}>RECIPIENT</Text>
            <View style={s.halfRow}>
              <View style={{ flex: 1 }}><Field label="First Name / Company Name" value={firstName} onChange={setFirstName} required /></View>
              <View style={{ flex: 1 }}><Field label="Last Name" value={lastName} onChange={setLastName} /></View>
            </View>
            <Field label="Phone Number" value={phone} onChange={setPhone} keyboardType="phone-pad" placeholder="+1 (555) 000-0000" />

            {/* SHIPPING ADDRESS */}
            <Text style={[s.sectionDivider, { color: colors.textSecondary, borderBottomColor: colors.border }]}>SHIPPING ADDRESS</Text>
            <Field label="Address 1" value={address1} onChange={setAddress1} required />
            <Field label="Address 2" value={address2} onChange={setAddress2} placeholder="Apt, Suite, Unit… (optional)" />
            <Field label="City" value={city} onChange={setCity} required />
            <View style={s.halfRow}>
              <View style={{ flex: 1 }}>
                <SelectField label="State" displayValue={stateName} onPress={() => setShowState(true)} required />
              </View>
              <View style={{ flex: 1 }}>
                <Field label="Postal Code" value={postalCode} onChange={setPostalCode} keyboardType="numeric" placeholder="75001" required />
              </View>
            </View>
            <Field label="Country" value={country} onChange={setCountry} required />

            {/* ORDER DETAILS */}
            <Text style={[s.sectionDivider, { color: colors.textSecondary, borderBottomColor: colors.border }]}>ORDER DETAILS</Text>

            {hasSmItems ? (
              <SelectField label="Shipping Method" displayValue={shippingLbl} onPress={() => setShowShipping(true)} required />
            ) : (
              <View style={s.fieldWrap}>
                <Text style={[s.fieldLabel, { color: colors.textSecondary }]}>Shipping Method</Text>
                <View style={[s.fieldInput, { backgroundColor: colors.background, borderColor: colors.border, justifyContent: 'center' }]}>
                  <Text style={{ color: colors.text, fontSize: 14 }}>Standard</Text>
                </View>
              </View>
            )}

            <Field label="PO Number" value={poNumber} onChange={setPo} placeholder="Optional" />

            {hasSmItems && smClinics.length > 1 && (
              <SelectField
                label="Clinic"
                displayValue={smClinics.find((c) => c.id === clinicId)?.name ?? ''}
                onPress={() => setShowClinic(true)}
                required
              />
            )}

            {/* Progress / error */}
            {submitting && progress ? (
              <Text style={[s.progressText, { color: colors.primary }]}>{progress}</Text>
            ) : null}
            {submitError && (
              <Text style={[s.submitError, { color: colors.critical }]}>{submitError}</Text>
            )}

            <Pressable
              onPress={submit}
              disabled={submitting}
              style={[s.submitBtn, { backgroundColor: submitting ? colors.muted : colors.primary }]}>
              {submitting
                ? <><ActivityIndicator size="small" color="#fff" /><Text style={s.submitBtnText}>{progress || 'Placing orders…'}</Text></>
                : <><ShoppingCart size={15} color="#fff" /><Text style={s.submitBtnText}>Place {totalItems} Item{totalItems !== 1 ? 's' : ''}</Text></>
              }
            </Pressable>
            <View style={{ height: 32 }} />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>

      <PickerModal visible={showState} title="Select State" options={US_STATES}
        value={stateCode as string} onSelect={(v) => setStateCode(v)} onClose={() => setShowState(false)} />
      <PickerModal visible={showShipping} title="Shipping Method" options={SM_SHIPPING_METHODS}
        value={shippingMethod} onSelect={(v) => setShipping(v)} onClose={() => setShowShipping(false)} />
      {smClinics.length > 1 && (
        <PickerModal visible={showClinic} title="Select Clinic"
          options={smClinics.map((c) => ({ label: c.name, value: c.id }))}
          value={clinicId} onSelect={(v) => setClinicId(v)} onClose={() => setShowClinic(false)} />
      )}
    </Modal>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────

type SourceFilter = '' | 'SmartMeter' | 'Tenovi';
type StatusFilter = '' | 'Pending' | 'Processing' | 'Shipped' | 'Delivered' | 'Activated' | 'Returned' | 'Cancelled';

const SOURCE_OPTIONS = [
  { label: 'SmartMeter', value: 'SmartMeter' },
  { label: 'Tenovi',     value: 'Tenovi' },
];
const STATUS_OPTIONS: { label: string; value: StatusFilter }[] = [
  { label: 'Pending', value: 'Pending' }, { label: 'Processing', value: 'Processing' },
  { label: 'Shipped', value: 'Shipped' }, { label: 'Delivered', value: 'Delivered' },
  { label: 'Activated', value: 'Activated' }, { label: 'Returned', value: 'Returned' },
  { label: 'Cancelled', value: 'Cancelled' },
];

export default function DeviceOrdersScreen() {
  const colors = useTheme();
  const { session } = useAuth();
  const { width: screenWidth } = useWindowDimensions();

  // ── Tab ────────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<'orders' | 'catalog'>('orders');

  // ── Orders ─────────────────────────────────────────────────────────────────
  const [orders, setOrders]         = useState<UnifiedOrder[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [search, setSearch]         = useState('');
  const [source, setSource]         = useState<SourceFilter>('');
  const [status, setStatus]         = useState<StatusFilter>('');

  // ── Catalog ────────────────────────────────────────────────────────────────
  const [catalogItems, setCatalogItems]   = useState<CatalogItem[]>([]);
  const [smClinics, setSmClinics]         = useState<SmClinic[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError]   = useState<string | null>(null);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogVendor, setCatalogVendor] = useState<'' | 'SmartMeter' | 'Tenovi'>('');
  const [syncing, setSyncing]             = useState(false);
  const [syncMsg, setSyncMsg]             = useState<string | null>(null);

  // ── Cart ───────────────────────────────────────────────────────────────────
  const [cart, setCart]             = useState<CartItem[]>([]);
  const [showCart, setShowCart]     = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);

  const totalCartItems = cart.reduce((n, c) => n + c.qty, 0);

  const addToCart = useCallback((item: CatalogItem) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.item.id === item.id);
      if (existing) {
        return prev.map((c) =>
          c.item.id === item.id ? { ...c, qty: Math.min(c.qty + 1, item.maxQty) } : c,
        );
      }
      return [...prev, { item, qty: 1 }];
    });
  }, []);

  const updateCartQty = useCallback((itemId: string, qty: number) => {
    setCart((prev) =>
      qty <= 0
        ? prev.filter((c) => c.item.id !== itemId)
        : prev.map((c) => c.item.id === itemId ? { ...c, qty } : c),
    );
  }, []);

  // ── Loaders ────────────────────────────────────────────────────────────────

  const loadOrders = useCallback(async (showSpinner = true) => {
    if (!session?.token) return;
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const { orders: data } = await api.listDeviceOrders(session.token);
      setOrders(data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load orders');
    } finally {
      setLoading(false);
    }
  }, [session?.token]);

  const loadCatalog = useCallback(async () => {
    if (!session?.token) return;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const { items, smClinics: clinics } = await api.getDeviceCatalog(session.token);
      setCatalogItems(items);
      setSmClinics(clinics);
      setCatalogLoaded(true);
    } catch (e: any) {
      setCatalogError(e?.message ?? 'Failed to load catalog');
    } finally {
      setCatalogLoading(false);
    }
  }, [session?.token]);

  const syncCatalog = useCallback(async () => {
    if (!session?.token || syncing) return;
    setSyncing(true);
    setSyncMsg(null);
    try {
      const result = await api.syncDeviceCatalog(session.token);
      setSyncMsg(`Synced ${result.synced} devices`);
      setCatalogLoaded(false);
      await loadCatalog();
    } catch (e: any) {
      setSyncMsg(e?.message ?? 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [session?.token, syncing, loadCatalog]);

  useEffect(() => { loadOrders(); }, [loadOrders]);

  useEffect(() => {
    if (activeTab === 'catalog' && !catalogLoaded && !catalogLoading) loadCatalog();
  }, [activeTab, catalogLoaded, catalogLoading, loadCatalog]);

  // ── Filtered views ─────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return orders.filter((o) => {
      if (source && o.source !== source) return false;
      if (status && o.status !== status) return false;
      if (q &&
          !o.orderNumber.toLowerCase().includes(q) &&
          !(o.patientName ?? '').toLowerCase().includes(q) &&
          !(o.clinicName ?? '').toLowerCase().includes(q) &&
          !o.devices.join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [orders, search, source, status]);

  const filteredCatalog = useMemo(() => {
    const q = catalogSearch.toLowerCase().trim();
    return catalogItems.filter((item) => {
      if (catalogVendor && item.vendor !== catalogVendor) return false;
      if (q && !item.name.toLowerCase().includes(q) &&
               !item.sku.toLowerCase().includes(q) &&
               !item.description.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalogItems, catalogSearch, catalogVendor]);

  const pending   = orders.filter((o) => ['Pending','Draft','Requested','Created','Processing','On Hold'].includes(o.status)).length;
  const inTransit = orders.filter((o) => ['Shipped','Dispatched','Updated'].includes(o.status)).length;
  const delivered = orders.filter((o) => ['Delivered','Confirmed'].includes(o.status)).length;
  const returned  = orders.filter((o) => ['Returned','Rerouted','Cancelled'].includes(o.status)).length;

  const cardW   = Math.min(220, (screenWidth - 48) / 2);
  const numCols = Math.max(1, Math.floor((screenWidth - 32) / cardW));

  return (
    <View style={[s.screen, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <PageHeader
          eyebrow="Fulfillment"
          title="Device Orders"
          description="End-to-end pipeline: SmartMeter & Tenovi orders, shipping, and delivery."
          actions={
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Pressable
                onPress={() => { setActiveTab('catalog'); }}
                style={[s.newOrderBtn, { backgroundColor: colors.primary }]}>
                <Plus size={14} color="#fff" />
                <Text style={s.newOrderBtnText}>New Order</Text>
              </Pressable>
              <Pressable
                onPress={() => setShowCart(true)}
                style={[s.cartIconBtn, {
                  backgroundColor: totalCartItems > 0 ? colors.primary : colors.card,
                  borderColor: totalCartItems > 0 ? colors.primary : colors.border,
                }]}>
                <ShoppingCart size={16} color={totalCartItems > 0 ? '#fff' : colors.textSecondary} />
                {totalCartItems > 0 && (
                  <View style={[s.cartBadge, { backgroundColor: '#fff' }]}>
                    <Text style={[s.cartBadgeText, { color: colors.primary }]}>{totalCartItems}</Text>
                  </View>
                )}
              </Pressable>
            </View>
          }
        />

        {/* Tab bar */}
        <TabBar active={activeTab} onChange={setActiveTab} />

        {/* ── Orders tab ──────────────────────────────────────────────────── */}
        {activeTab === 'orders' && (
          <>
            <View style={s.kpiRow}>
              <KpiCard label="Pending / Processing" value={pending}   icon={Clock}     tone="warning" />
              <KpiCard label="In Transit"           value={inTransit} icon={Truck}     tone="info"    />
              <KpiCard label="Delivered"            value={delivered} icon={Package}   tone="primary" />
              <KpiCard label="Returned / Cancelled" value={returned}  icon={RefreshCw} tone="critical" />
            </View>
            {!loading && orders.length > 0 && (
              <Card style={{ gap: 10 }}>
                <Text style={[s.sectionLabel, { color: colors.textSecondary }]}>PIPELINE</Text>
                <PipelineBar orders={orders} />
              </Card>
            )}
            <Card style={{ gap: 10 }}>
              <TextInput
                style={[s.searchInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
                placeholder="Search order #, patient, clinic, device…"
                placeholderTextColor={colors.textSecondary}
                value={search} onChangeText={setSearch}
              />
              <View style={s.filterRow}>
                <FilterSelect label="All Sources" value={source} options={SOURCE_OPTIONS}
                  onChange={(v) => setSource(v as SourceFilter)} />
                <FilterSelect label="All Statuses" value={status}
                  options={STATUS_OPTIONS as { label: string; value: string }[]}
                  onChange={(v) => setStatus(v as StatusFilter)} />
                <Pressable onPress={() => { setSearch(''); setSource(''); setStatus(''); }}
                  style={[s.clearBtn, { borderColor: colors.border }]}>
                  <Text style={[s.clearBtnText, { color: colors.textSecondary }]}>Clear</Text>
                </Pressable>
                <Pressable onPress={() => loadOrders(false)}
                  style={[s.refreshBtn, { backgroundColor: colors.primary + '14', borderColor: colors.primary + '30' }]}>
                  <RefreshCw size={13} color={colors.primary} />
                  <Text style={[s.refreshBtnText, { color: colors.primary }]}>Refresh</Text>
                </Pressable>
              </View>
              <Text style={[s.countLabel, { color: colors.textSecondary }]}>
                Showing {filtered.length} of {orders.length} orders (last 30 days)
              </Text>
            </Card>
            <Card style={{ overflow: 'hidden' }}>
              {loading ? (
                <View style={s.center}>
                  <ActivityIndicator size="large" color={colors.primary} />
                  <Text style={[s.loadingText, { color: colors.textSecondary }]}>Loading orders from SmartMeter & Tenovi…</Text>
                  <Text style={[s.loadingHint, { color: colors.textSecondary }]}>First load may take up to 20s</Text>
                </View>
              ) : error ? (
                <View style={s.center}>
                  <Text style={[s.errorText, { color: colors.critical }]}>{error}</Text>
                  <Pressable onPress={() => loadOrders()} style={[s.retryBtn, { backgroundColor: colors.primary }]}>
                    <Text style={s.retryBtnText}>Retry</Text>
                  </Pressable>
                </View>
              ) : (
                <OrdersTable orders={filtered} />
              )}
            </Card>
          </>
        )}

        {/* ── Catalog tab ─────────────────────────────────────────────────── */}
        {activeTab === 'catalog' && (
          <>
            <Card style={{ gap: 10 }}>
              <TextInput
                style={[s.searchInput, { backgroundColor: colors.background, borderColor: colors.border, color: colors.text }]}
                placeholder="Search devices…"
                placeholderTextColor={colors.textSecondary}
                value={catalogSearch} onChangeText={setCatalogSearch}
              />
              <View style={s.filterRow}>
                <FilterSelect label="All Vendors" value={catalogVendor} options={SOURCE_OPTIONS}
                  onChange={(v) => setCatalogVendor(v as '' | 'SmartMeter' | 'Tenovi')} />
                <Pressable onPress={() => { setCatalogSearch(''); setCatalogVendor(''); }}
                  style={[s.clearBtn, { borderColor: colors.border }]}>
                  <Text style={[s.clearBtnText, { color: colors.textSecondary }]}>Clear</Text>
                </Pressable>
                <Pressable onPress={() => { setCatalogLoaded(false); loadCatalog(); }}
                  style={[s.refreshBtn, { backgroundColor: colors.primary + '14', borderColor: colors.primary + '30' }]}>
                  <RefreshCw size={13} color={colors.primary} />
                  <Text style={[s.refreshBtnText, { color: colors.primary }]}>Refresh</Text>
                </Pressable>
                {session?.user.role === 'super_admin' && (
                  <Pressable onPress={syncCatalog} disabled={syncing}
                    style={[s.refreshBtn, { backgroundColor: colors.success + '14', borderColor: colors.success + '30', opacity: syncing ? 0.6 : 1 }]}>
                    {syncing
                      ? <ActivityIndicator size="small" color={colors.success} />
                      : <RotateCw size={13} color={colors.success} />
                    }
                    <Text style={[s.refreshBtnText, { color: colors.success }]}>{syncing ? 'Syncing…' : 'Sync from APIs'}</Text>
                  </Pressable>
                )}
              </View>
              <View style={s.filterRow}>
                {catalogLoaded && (
                  <Text style={[s.countLabel, { color: colors.textSecondary }]}>
                    {filteredCatalog.length} device{filteredCatalog.length !== 1 ? 's' : ''} available
                  </Text>
                )}
                {syncMsg && <Text style={[s.countLabel, { color: colors.success }]}>{syncMsg}</Text>}
              </View>
            </Card>

            {catalogLoading ? (
              <Card style={s.center}>
                <ActivityIndicator size="large" color={colors.primary} />
                <Text style={[s.loadingText, { color: colors.textSecondary }]}>Loading device catalog…</Text>
              </Card>
            ) : catalogError ? (
              <Card style={s.center}>
                <Text style={[s.errorText, { color: colors.critical }]}>{catalogError}</Text>
                <Pressable onPress={loadCatalog} style={[s.retryBtn, { backgroundColor: colors.primary }]}>
                  <Text style={s.retryBtnText}>Retry</Text>
                </Pressable>
              </Card>
            ) : filteredCatalog.length === 0 ? (
              <Card style={s.center}>
                <Package size={28} color={colors.textSecondary} strokeWidth={1.5} />
                <Text style={[s.emptyText, { color: colors.textSecondary }]}>
                  {catalogItems.length === 0 ? 'No devices in catalog — tap Sync from APIs' : 'No devices match filters'}
                </Text>
              </Card>
            ) : (
              <View style={{ gap: 12 }}>
                {Array.from({ length: Math.ceil(filteredCatalog.length / numCols) }, (_, rowIdx) => {
                  const rowItems = filteredCatalog.slice(rowIdx * numCols, rowIdx * numCols + numCols);
                  return (
                    <View key={rowIdx} style={[s.catalogRow, { gap: 12 }]}>
                      {rowItems.map((item) => (
                        <View key={item.id} style={{ flex: 1, maxWidth: cardW }}>
                          <CatalogCard
                            item={item}
                            cartQty={cart.find((c) => c.item.id === item.id)?.qty ?? 0}
                            onAdd={() => addToCart(item)}
                            onUpdateQty={(qty) => updateCartQty(item.id, qty)}
                          />
                        </View>
                      ))}
                      {rowItems.length < numCols &&
                        Array.from({ length: numCols - rowItems.length }).map((_, i) => (
                          <View key={`ph-${i}`} style={{ flex: 1, maxWidth: cardW }} />
                        ))
                      }
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )}

        {/* Legend */}
        <View style={{ gap: 8 }}>
          <View style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: colors.primary }]} />
            <Text style={[s.legendText, { color: colors.textSecondary }]}>SmartMeter — iBP, iGlucose cellular devices</Text>
          </View>
          <View style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: colors.info }]} />
            <Text style={[s.legendText, { color: colors.textSecondary }]}>Tenovi — BPM, Scale, Pillbox, Gateway bulk orders</Text>
          </View>
        </View>
      </ScrollView>

      {/* Cart sheet */}
      {showCart && (
        <CartSheet
          cart={cart}
          onUpdateQty={updateCartQty}
          onCheckout={() => { setShowCart(false); setShowCheckout(true); }}
          onClose={() => setShowCart(false)}
        />
      )}

      {/* Checkout sheet */}
      {showCheckout && (
        <CheckoutSheet
          cart={cart}
          smClinics={smClinics}
          token={session?.token ?? ''}
          onClose={() => setShowCheckout(false)}
          onSuccess={() => {
            setShowCheckout(false);
            setCart([]);
            setActiveTab('orders');
            loadOrders(false);
          }}
        />
      )}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { padding: 16, gap: 16, paddingBottom: 40 },

  // Header buttons
  newOrderBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
  },
  newOrderBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  cartIconBtn: {
    width: 38, height: 38, borderRadius: 10, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  cartBadge: {
    position: 'absolute', top: -6, right: -6,
    minWidth: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4,
  },
  cartBadgeText: { fontSize: 10, fontWeight: '800' },

  // Tab bar
  tabBar:   { flexDirection: 'row', borderRadius: 10, borderWidth: 1, padding: 4, gap: 4, alignSelf: 'flex-start' },
  tabItem:  { paddingHorizontal: 16, paddingVertical: 7, borderRadius: 8 },
  tabText:  { fontSize: 13, fontWeight: '600' },

  // KPI
  kpiRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  sectionLabel: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },

  // Filters
  searchInput: { height: 38, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, fontSize: 13 },
  filterRow:   { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  filterBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1,
    minWidth: 100, maxWidth: 160,
  },
  filterBtnText: { fontSize: 12, fontWeight: '600', flex: 1 },
  clearBtn:   { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1 },
  clearBtnText: { fontSize: 12, fontWeight: '600' },
  refreshBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1,
  },
  refreshBtnText: { fontSize: 12, fontWeight: '600' },
  countLabel: { fontSize: 11.5 },

  // Pipeline
  pipeline:     { flexDirection: 'row', alignItems: 'center', gap: 4 },
  pipelineItem: { alignItems: 'center', gap: 4, flexDirection: 'row' },
  pipelineNode: {
    width: 48, height: 48, borderRadius: 24, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  pipelineCount: { fontSize: 16, fontWeight: '800' },
  pipelineLabel: { fontSize: 11, fontWeight: '600', marginLeft: 4 },
  pipelineArrow: { fontSize: 16, marginHorizontal: 6 },

  // Catalog grid
  catalogRow: { flexDirection: 'row' },
  catalogCard: {
    flex: 1, borderRadius: 12, borderWidth: 1.5, padding: 12, gap: 8,
  },
  catalogImg: { width: '100%', height: 100, borderRadius: 8 },
  catalogImgPlaceholder: {
    width: '100%', height: 100, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  vendorBadge: { alignSelf: 'flex-start', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  vendorText:  { fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  catalogName: { fontSize: 13, fontWeight: '700', lineHeight: 18 },
  catalogSku:  { fontSize: 10.5, fontFamily: 'monospace' },
  pricingRow:  { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  priceTag:    { fontSize: 13, fontWeight: '700' },
  priceSub:    { fontSize: 11.5 },
  stockPill:   { alignSelf: 'flex-start', borderRadius: 5, paddingHorizontal: 7, paddingVertical: 3 },
  stockText:   { fontSize: 10, fontWeight: '700' },

  // Catalog card — cart controls
  addToCartBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingVertical: 9, borderRadius: 8, marginTop: 2,
  },
  addToCartBtnText: { fontSize: 12, fontWeight: '700' },
  cartStepper: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderRadius: 8, borderWidth: 1, paddingHorizontal: 4, paddingVertical: 4, marginTop: 2,
  },
  cartStepBtn: {
    width: 32, height: 32, borderRadius: 7, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  cartStepBtnText: { fontSize: 16, fontWeight: '700' },
  cartStepCount:   { fontSize: 16, fontWeight: '800', minWidth: 28, textAlign: 'center' },

  // Modal overlay
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  pickerCard: {
    borderRadius: 12, borderWidth: 1, paddingVertical: 6, minWidth: 180, maxWidth: 320,
    shadowColor: '#000', shadowOpacity: 0.12, shadowRadius: 12, elevation: 6,
  },
  pickerOpt:     { paddingHorizontal: 16, paddingVertical: 12 },
  pickerOptText: { fontSize: 14, fontWeight: '500' },

  // Bottom sheets (cart, checkout)
  sheet: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1,
    maxHeight: '90%',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 14,
  },
  checkoutSheet: { maxHeight: '94%' },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center',
    padding: 18, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: { fontSize: 18, fontWeight: '800' },
  sheetSub:   { fontSize: 12, marginTop: 2 },
  closeBtn: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
  },

  // Cart sheet rows
  cartRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 18, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  cartThumb: { width: 56, height: 56, borderRadius: 10 },
  cartThumbPlaceholder: {
    width: 56, height: 56, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  cartItemName:  { fontSize: 13, fontWeight: '700', lineHeight: 18 },
  cartItemMeta:  { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  cartItemSku:   { fontSize: 11, fontFamily: 'monospace' },
  cartItemPrice: { fontSize: 11.5 },
  vendorBadgeSmall: { borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  vendorTextSmall:  { fontSize: 9, fontWeight: '700', textTransform: 'uppercase' },
  cartQtyCol: { alignItems: 'center', gap: 6 },
  cartQtyStepper: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 8, borderWidth: 1, overflow: 'hidden',
  },
  cartQtyBtn:    { paddingHorizontal: 10, paddingVertical: 6 },
  cartQtyBtnTxt: { fontSize: 16, fontWeight: '700' },
  cartQtyNum:    { fontSize: 14, fontWeight: '800', paddingHorizontal: 10 },
  removeBtn:     { padding: 4 },

  // Cart footer
  sheetFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    padding: 18, borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerTotal: { fontSize: 15, fontWeight: '700' },
  footerSub:   { fontSize: 11 },
  checkoutBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10,
  },
  checkoutBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  // Picker sheet
  pickerSheet: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderLeftWidth: 1, borderRightWidth: 1,
    maxHeight: '60%',
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 20, elevation: 14,
  },
  pickerSheetOpt: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pickerSheetOptText: { fontSize: 15, fontWeight: '500' },

  // Checkout form
  fieldWrap:  { paddingHorizontal: 18, paddingVertical: 5 },
  fieldLabel: { fontSize: 11, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 },
  fieldInput: { height: 42, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  selectInput: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12,
  },
  halfRow: { flexDirection: 'row' },
  sectionDivider: {
    fontSize: 10, fontWeight: '700', letterSpacing: 0.8,
    paddingHorizontal: 18, paddingTop: 14, paddingBottom: 2,
    borderBottomWidth: StyleSheet.hairlineWidth, marginBottom: 4,
  },

  // Order summary in checkout
  orderSummary: {
    marginHorizontal: 18, marginTop: 14, borderRadius: 10, borderWidth: 1,
    paddingVertical: 4, gap: 0,
  },
  summaryRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  summaryItemName: { flex: 1, fontSize: 13, fontWeight: '500' },
  summaryQty: { fontSize: 13, fontWeight: '700' },

  // Submit
  progressText: { fontSize: 12, paddingHorizontal: 18, paddingTop: 8, fontStyle: 'italic' },
  submitError:  { fontSize: 12, paddingHorizontal: 18, paddingTop: 6 },
  submitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginHorizontal: 18, marginTop: 16, paddingVertical: 15, borderRadius: 12,
  },
  submitBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },

  // Table
  tableHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1,
  },
  th: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
  tableRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  orderNum:      { fontSize: 12.5, fontWeight: '700', fontFamily: 'monospace' },
  fulfilledRow:  { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 },
  fulfilledText: { fontSize: 9.5, fontWeight: '600' },
  devicesList:   { fontSize: 12, fontWeight: '500' },
  recipientSub:  { fontSize: 11, marginTop: 2 },
  sourcePill:    { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  sourcePillText:{ fontSize: 11, fontWeight: '700' },
  trackingLink:  { fontSize: 12, fontWeight: '600', textDecorationLine: 'underline' },
  tracking:      { fontSize: 11.5, fontFamily: 'monospace' },
  carrier:       { fontSize: 10.5, marginTop: 2 },
  dateText:      { fontSize: 12 },
  shippedText:   { fontSize: 10.5, marginTop: 2 },

  center:       { alignItems: 'center', paddingVertical: 40, gap: 12 },
  emptyBox: {
    alignItems: 'center', paddingVertical: 40, gap: 10,
    borderRadius: 10, borderWidth: 1, borderStyle: 'dashed',
  },
  emptyText:    { fontSize: 13 },
  loadingText:  { fontSize: 13, textAlign: 'center' },
  loadingHint:  { fontSize: 11, textAlign: 'center' },
  errorText:    { fontSize: 13, textAlign: 'center' },
  retryBtn:     { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  retryBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot:  { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11 },
});
