# tasks-filter-pro

Chrome extension for building Browswave task queries (category, brand, country, company chips).

## Brands

- Settings (gear in the popup) open in a full tab: edit the brand list of each category, import / export, scan the page.
- `brands.json` is loaded once when the extension is installed (and once on first open after updating to 1.3.0).
  Replace it with your own list before loading the extension. Format:

```json
{
  "format": "tasks-filter-pro-brands",
  "version": 1,
  "lists": [
    { "id": "*", "name": "All categories", "brands": ["Acer", "Asus"] },
    { "name": "Laptops", "brands": ["Dell", "HP", "Lenovo"] }
  ]
}
```

  `"id": "*"` is the list shared by every category. A list can use the category `id` or just its `name`
  (names are matched against the categories once the popup has connected to the tasks page).
- The popup's Brand field has an **Add all** button: it adds every suggestion matching what is typed in the box.
