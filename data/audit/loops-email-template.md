# Loops Transactional Email Template

## Subject Line
```
Updates for {{showTitle}} on Broadway Scorecard
```

## Body (use Loops visual editor — don't paste HTML)

Since Loops uses its own data variable format, build the email in the **Styled** editor:

1. Type: `What's new with `
2. Click `{ }` toolbar button → create data variable `showTitle`
3. Type `:` and press Enter twice
4. Click `{ }` → create data variable `changes`
5. Press Enter twice
6. Add a button component (use the button icon in toolbar):
   - Text: `View Full Details`
   - URL: click `{ }` inside the URL field → create data variable `showUrl`
7. Press Enter twice, type `—` (em dash)
8. Press Enter, type: `You're receiving this because you followed `
9. Click `{ }` → insert `showTitle` again
10. Type: ` on Broadway Scorecard.`

That's it — then click **Publish**.
