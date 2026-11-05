# Action Product Importer (Chrome extension)

## Install
1. Unzip this folder.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and pick the `action-importer` folder.
4. Pin the extension and click its icon to open the side panel.

## Use
1. **Log in** with your phone + password (choose Production or Staging first).
   Brands and categories are loaded right after login (↻ reloads them).
2. Open a product on **abdeencenter.com** and click the purple **Import to Action** button
   (next to *Add to cart*), or on a category page use **Import all on page** in the small dock.
   Each product is read in Arabic and English, with price, old price, images, specs, SKU and URL.
   Re-importing the same product records price changes (price history).
3. In the side panel: set **Defaults for new imports** (brand + categories), select products,
   then **Upload images** → **Save**. Saved products show `Saved #id`; saving again updates them.
4. **⋯ menu** → Export to Excel / Import from Excel.

Each product card now includes a searchable **Brand** selector and expandable
**Categories** tree. Selections are saved locally immediately; **Save / Update**
sends them to the backend with the product. After upgrading, click the lookup
reload button once to refresh cached categories and include their children.

## Settings worth checking
- **API endpoints**: categories lookup path is `/lookups/categories` by default — change it if yours differs.
- **Save payload → where images go**: `mediaCollective` by default (as in the sample product).
- **Product template**: paste the JSON your admin panel sends when creating a product if saving is refused.
- **Source sites**: add other shops; they get the same Import buttons.
- New products are saved **unpublished** by default (Settings → New product defaults).
