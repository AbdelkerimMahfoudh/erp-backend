import { Prisma, TrackingType } from '@prisma/client';
import { newUuidV7Bin } from '../common/utils/uuid.util';
import { AttributeDef } from '../tracking/attribute-def';

/**
 * The built-in category taxonomy every company starts with (D223).
 *
 * ## Keys, not names
 *
 * A built-in category is identified by `key` — stable, never displayed, never
 * translated. The app shows it by its key in English, French or Arabic, so a
 * translation can change without touching a row, and nothing anywhere reads a
 * category's NAME to decide behaviour (that rule is unchanged). The stored
 * `name` is the English label, kept for exports and the API; it is not unique
 * against a shop's own categories, which keep their names untouched.
 *
 * ## One level of depth
 *
 * A top-level category groups subcategories ("Audio" → "Earbuds"). Products may
 * sit in either. There is no third level: a shop needs to find things, not run a
 * taxonomy.
 *
 * ## Tracking: recommended, and allowed
 *
 * `trackingType` is what a new product in the category starts with. `allowed` is
 * every mode the Owner may choose instead: a tablet is IMEI-tracked when cellular
 * and serial- or quantity-tracked when Wi-Fi only; earbuds may be counted or
 * tracked one by one. Anything not listed is refused, so a cable can never be made
 * to demand an IMEI. Custom categories allow every selectable mode.
 *
 * ## Attributes
 *
 * The adaptive fields of the product form, in the existing category schema
 * format. None is required: the minimum to receive stock is a category, a
 * name or model, a valid tracking mode, the buying cost, the quantity or
 * identifier and the store (D223).
 */
export interface DefaultCategory {
  key: string;
  /** English label, stored as the row's name. The app displays it translated by key. */
  name: string;
  parentKey?: string;
  trackingType: TrackingType;
  allowed: readonly TrackingType[];
  attributes: readonly AttributeDef[];
  /** Display order among its siblings. */
  order: number;
}

const { imei, serial, quantity } = TrackingType;

const COLOR: AttributeDef = { key: 'color', label: 'Colour', type: 'text' };
const STORAGE: AttributeDef = { key: 'storage', label: 'Storage', type: 'measurement', unit: 'GB' };
const COMPATIBLE: AttributeDef = { key: 'compatible_with', label: 'Fits', type: 'text' };
const CONNECTOR: AttributeDef = {
  key: 'connector',
  label: 'Connector',
  type: 'enum',
  options: ['USB-C', 'Lightning', 'Micro-USB', 'USB-A', 'HDMI', 'Other'],
};
const WATTAGE: AttributeDef = { key: 'wattage', label: 'Power', type: 'measurement', unit: 'W' };

export const DEFAULT_CATEGORIES: readonly DefaultCategory[] = [
  // ── Phones ────────────────────────────────────────────────────────────────
  { key: 'phones', name: 'Phones', trackingType: imei, allowed: [imei], attributes: [STORAGE, COLOR], order: 1 },
  { key: 'phones.smartphones', name: 'Smartphones', parentKey: 'phones', trackingType: imei, allowed: [imei], attributes: [STORAGE, COLOR], order: 1 },
  { key: 'phones.feature', name: 'Feature phones', parentKey: 'phones', trackingType: imei, allowed: [imei], attributes: [COLOR], order: 2 },

  // ── Tablets: IMEI only when cellular ──────────────────────────────────────
  { key: 'tablets', name: 'Tablets', trackingType: serial, allowed: [imei, serial, quantity], attributes: [STORAGE, COLOR, { key: 'connectivity', label: 'Connectivity', type: 'enum', options: ['Wi-Fi', 'Cellular'] }], order: 2 },
  { key: 'tablets.cellular', name: 'Cellular tablets', parentKey: 'tablets', trackingType: imei, allowed: [imei], attributes: [STORAGE, COLOR], order: 1 },
  { key: 'tablets.wifi', name: 'Wi-Fi tablets', parentKey: 'tablets', trackingType: serial, allowed: [serial, quantity], attributes: [STORAGE, COLOR], order: 2 },

  // ── Laptops and computers ─────────────────────────────────────────────────
  { key: 'computers', name: 'Laptops and computers', trackingType: serial, allowed: [serial, quantity], attributes: [], order: 3 },
  {
    key: 'computers.laptops',
    name: 'Laptops',
    parentKey: 'computers',
    trackingType: serial,
    allowed: [serial, quantity],
    attributes: [
      { key: 'processor', label: 'Processor', type: 'text' },
      { key: 'ram', label: 'RAM', type: 'measurement', unit: 'GB' },
      STORAGE,
      COLOR,
    ],
    order: 1,
  },
  { key: 'computers.desktops', name: 'Desktop computers', parentKey: 'computers', trackingType: serial, allowed: [serial, quantity], attributes: [{ key: 'processor', label: 'Processor', type: 'text' }, { key: 'ram', label: 'RAM', type: 'measurement', unit: 'GB' }, STORAGE], order: 2 },
  { key: 'computers.monitors', name: 'Monitors', parentKey: 'computers', trackingType: serial, allowed: [serial, quantity], attributes: [{ key: 'screen_size', label: 'Screen size', type: 'measurement', unit: 'in' }], order: 3 },

  // ── Wearables ─────────────────────────────────────────────────────────────
  { key: 'wearables', name: 'Wearables', trackingType: serial, allowed: [imei, serial, quantity], attributes: [COLOR], order: 4 },
  { key: 'wearables.smartwatches', name: 'Smartwatches', parentKey: 'wearables', trackingType: serial, allowed: [imei, serial, quantity], attributes: [COLOR, { key: 'size', label: 'Size', type: 'measurement', unit: 'mm' }], order: 1 },
  { key: 'wearables.bands', name: 'Fitness bands', parentKey: 'wearables', trackingType: quantity, allowed: [serial, quantity], attributes: [COLOR], order: 2 },

  // ── Audio: counted, or tracked one by one ─────────────────────────────────
  { key: 'audio', name: 'Audio', trackingType: quantity, allowed: [serial, quantity], attributes: [COLOR], order: 5 },
  { key: 'audio.earbuds', name: 'Earbuds', parentKey: 'audio', trackingType: quantity, allowed: [serial, quantity], attributes: [COLOR], order: 1 },
  { key: 'audio.headphones', name: 'Headphones', parentKey: 'audio', trackingType: quantity, allowed: [serial, quantity], attributes: [{ key: 'wireless', label: 'Connection', type: 'enum', options: ['Wired', 'Wireless'] }, COLOR], order: 2 },
  { key: 'audio.headsets', name: 'Headsets', parentKey: 'audio', trackingType: quantity, allowed: [serial, quantity], attributes: [{ key: 'wireless', label: 'Connection', type: 'enum', options: ['Wired', 'Wireless'] }, COLOR], order: 3 },
  { key: 'audio.speakers', name: 'Speakers', parentKey: 'audio', trackingType: quantity, allowed: [serial, quantity], attributes: [COLOR], order: 4 },

  // ── Chargers and adapters ─────────────────────────────────────────────────
  { key: 'chargers', name: 'Chargers and adapters', trackingType: quantity, allowed: [quantity], attributes: [CONNECTOR, WATTAGE], order: 6 },
  { key: 'chargers.wall', name: 'Wall chargers', parentKey: 'chargers', trackingType: quantity, allowed: [quantity], attributes: [CONNECTOR, WATTAGE], order: 1 },
  { key: 'chargers.car', name: 'Car chargers', parentKey: 'chargers', trackingType: quantity, allowed: [quantity], attributes: [CONNECTOR, WATTAGE], order: 2 },
  { key: 'chargers.wireless', name: 'Wireless chargers', parentKey: 'chargers', trackingType: quantity, allowed: [quantity], attributes: [WATTAGE], order: 3 },
  { key: 'chargers.adapters', name: 'Power adapters', parentKey: 'chargers', trackingType: quantity, allowed: [quantity], attributes: [CONNECTOR, WATTAGE], order: 4 },

  // ── Cables ────────────────────────────────────────────────────────────────
  { key: 'cables', name: 'Cables', trackingType: quantity, allowed: [quantity], attributes: [{ key: 'ends', label: 'Ends', type: 'text' }, { key: 'length', label: 'Length', type: 'measurement', unit: 'm' }, WATTAGE], order: 7 },
  { key: 'cables.usbc', name: 'USB-C', parentKey: 'cables', trackingType: quantity, allowed: [quantity], attributes: [{ key: 'length', label: 'Length', type: 'measurement', unit: 'm' }, WATTAGE], order: 1 },
  { key: 'cables.lightning', name: 'Lightning', parentKey: 'cables', trackingType: quantity, allowed: [quantity], attributes: [{ key: 'length', label: 'Length', type: 'measurement', unit: 'm' }], order: 2 },
  { key: 'cables.microusb', name: 'Micro-USB', parentKey: 'cables', trackingType: quantity, allowed: [quantity], attributes: [{ key: 'length', label: 'Length', type: 'measurement', unit: 'm' }], order: 3 },
  { key: 'cables.hdmi', name: 'HDMI', parentKey: 'cables', trackingType: quantity, allowed: [quantity], attributes: [{ key: 'length', label: 'Length', type: 'measurement', unit: 'm' }], order: 4 },
  { key: 'cables.other', name: 'Other cables', parentKey: 'cables', trackingType: quantity, allowed: [quantity], attributes: [{ key: 'ends', label: 'Ends', type: 'text' }, { key: 'length', label: 'Length', type: 'measurement', unit: 'm' }], order: 5 },

  // ── Power banks ───────────────────────────────────────────────────────────
  { key: 'powerbanks', name: 'Power banks', trackingType: quantity, allowed: [serial, quantity], attributes: [{ key: 'capacity', label: 'Capacity', type: 'measurement', unit: 'mAh' }, { key: 'output', label: 'Output', type: 'measurement', unit: 'W' }, { key: 'connectors', label: 'Connectors', type: 'text' }], order: 8 },

  // ── Cases and covers ──────────────────────────────────────────────────────
  { key: 'cases', name: 'Phone cases and covers', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE, { key: 'material', label: 'Material', type: 'text' }, COLOR], order: 9 },

  // ── Screen protection ─────────────────────────────────────────────────────
  { key: 'protection', name: 'Screen protection', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE, { key: 'material', label: 'Type', type: 'text' }, { key: 'privacy', label: 'Privacy', type: 'enum', options: ['Yes', 'No'] }], order: 10 },
  { key: 'protection.glass', name: 'Tempered glass', parentKey: 'protection', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE, { key: 'privacy', label: 'Privacy', type: 'enum', options: ['Yes', 'No'] }], order: 1 },
  { key: 'protection.films', name: 'Films', parentKey: 'protection', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE], order: 2 },
  { key: 'protection.privacy', name: 'Privacy protectors', parentKey: 'protection', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE], order: 3 },
  { key: 'protection.camera', name: 'Camera protectors', parentKey: 'protection', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE], order: 4 },

  // ── Computer accessories ──────────────────────────────────────────────────
  { key: 'pcaccessories', name: 'Computer accessories', trackingType: quantity, allowed: [serial, quantity], attributes: [COLOR], order: 11 },
  { key: 'pcaccessories.mice', name: 'Mice', parentKey: 'pcaccessories', trackingType: quantity, allowed: [serial, quantity], attributes: [{ key: 'wireless', label: 'Connection', type: 'enum', options: ['Wired', 'Wireless'] }], order: 1 },
  { key: 'pcaccessories.keyboards', name: 'Keyboards', parentKey: 'pcaccessories', trackingType: quantity, allowed: [serial, quantity], attributes: [{ key: 'wireless', label: 'Connection', type: 'enum', options: ['Wired', 'Wireless'] }, { key: 'layout', label: 'Layout', type: 'text' }], order: 2 },
  { key: 'pcaccessories.stands', name: 'Laptop stands', parentKey: 'pcaccessories', trackingType: quantity, allowed: [quantity], attributes: [], order: 3 },
  { key: 'pcaccessories.webcams', name: 'Webcams', parentKey: 'pcaccessories', trackingType: quantity, allowed: [serial, quantity], attributes: [], order: 4 },

  // ── Storage ───────────────────────────────────────────────────────────────
  { key: 'storage', name: 'Storage', trackingType: quantity, allowed: [serial, quantity], attributes: [STORAGE], order: 12 },
  { key: 'storage.memorycards', name: 'Memory cards', parentKey: 'storage', trackingType: quantity, allowed: [quantity], attributes: [STORAGE, { key: 'class', label: 'Speed class', type: 'text' }], order: 1 },
  { key: 'storage.usb', name: 'USB drives', parentKey: 'storage', trackingType: quantity, allowed: [quantity], attributes: [STORAGE], order: 2 },
  { key: 'storage.ssd', name: 'SSDs', parentKey: 'storage', trackingType: quantity, allowed: [serial, quantity], attributes: [STORAGE], order: 3 },
  { key: 'storage.hdd', name: 'Hard drives', parentKey: 'storage', trackingType: quantity, allowed: [serial, quantity], attributes: [STORAGE], order: 4 },

  // ── Networking: a MiFi carries an IMEI, a router a serial ─────────────────
  { key: 'networking', name: 'Networking', trackingType: serial, allowed: [imei, serial, quantity], attributes: [{ key: 'network', label: 'Network', type: 'enum', options: ['3G', '4G', '5G', 'Wi-Fi'] }], order: 13 },
  { key: 'networking.routers', name: 'Routers', parentKey: 'networking', trackingType: serial, allowed: [imei, serial, quantity], attributes: [{ key: 'network', label: 'Network', type: 'enum', options: ['3G', '4G', '5G', 'Wi-Fi'] }], order: 1 },
  { key: 'networking.mifi', name: 'MiFi devices', parentKey: 'networking', trackingType: imei, allowed: [imei, serial], attributes: [{ key: 'network', label: 'Network', type: 'enum', options: ['3G', '4G', '5G'] }], order: 2 },
  { key: 'networking.repeaters', name: 'Repeaters', parentKey: 'networking', trackingType: quantity, allowed: [serial, quantity], attributes: [], order: 3 },
  { key: 'networking.accessories', name: 'Network accessories', parentKey: 'networking', trackingType: quantity, allowed: [quantity], attributes: [], order: 4 },

  // ── Gaming ────────────────────────────────────────────────────────────────
  { key: 'gaming', name: 'Gaming', trackingType: serial, allowed: [serial, quantity], attributes: [], order: 14 },
  { key: 'gaming.consoles', name: 'Consoles', parentKey: 'gaming', trackingType: serial, allowed: [serial, quantity], attributes: [STORAGE, COLOR], order: 1 },
  { key: 'gaming.controllers', name: 'Controllers', parentKey: 'gaming', trackingType: quantity, allowed: [serial, quantity], attributes: [COLOR], order: 2 },
  { key: 'gaming.accessories', name: 'Gaming accessories', parentKey: 'gaming', trackingType: quantity, allowed: [quantity], attributes: [], order: 3 },

  // ── Parts and repair stock ────────────────────────────────────────────────
  { key: 'parts', name: 'Parts and repair stock', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE], order: 15 },
  { key: 'parts.screens', name: 'Screens', parentKey: 'parts', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE], order: 1 },
  { key: 'parts.batteries', name: 'Batteries', parentKey: 'parts', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE, { key: 'capacity', label: 'Capacity', type: 'measurement', unit: 'mAh' }], order: 2 },
  { key: 'parts.ports', name: 'Charging ports', parentKey: 'parts', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE], order: 3 },
  { key: 'parts.cameras', name: 'Camera modules', parentKey: 'parts', trackingType: quantity, allowed: [quantity], attributes: [COMPATIBLE], order: 4 },

  // ── Everything else ───────────────────────────────────────────────────────
  { key: 'other', name: 'Other electronics', trackingType: quantity, allowed: [imei, serial, quantity], attributes: [], order: 16 },
];

/** The built-in category with this key. */
export function defaultCategory(key: string | null | undefined): DefaultCategory | undefined {
  return key ? DEFAULT_CATEGORIES.find((c) => c.key === key) : undefined;
}

/** What creating the built-in categories needs from a caller's transaction. */
export interface CategorySeedClient {
  productCategory: {
    create(args: { data: Prisma.ProductCategoryUncheckedCreateInput }): Promise<unknown>;
  };
}

/**
 * Give a new company the built-in taxonomy, inside the transaction that creates
 * it (registration). Parents first, so each subcategory points at its own
 * company's parent. Existing companies received the same rows from migration 0104.
 */
export async function seedDefaultCategories(tx: CategorySeedClient, companyId: Buffer): Promise<void> {
  const ids = new Map<string, Buffer>();
  for (const level of ['top', 'child'] as const) {
    for (const c of DEFAULT_CATEGORIES.filter((d) => (level === 'top' ? !d.parentKey : !!d.parentKey))) {
      const id = newUuidV7Bin();
      ids.set(c.key, id);
      await tx.productCategory.create({
        data: {
          id,
          companyId,
          key: c.key,
          parentId: c.parentKey ? ids.get(c.parentKey)! : null,
          name: c.name,
          defaultTrackingType: c.trackingType,
          attributeSchema: c.attributes as unknown as Prisma.InputJsonValue,
          isActive: true,
        },
      });
    }
  }
}
