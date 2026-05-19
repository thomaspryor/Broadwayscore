# Demo subdomain pin

`demo.broadwayscorecard.com` auto-aliases to whatever was just deployed by
the `vercel-demo.yml` workflow. That's fine for "keep demo close to main"
but makes reviewing a feature branch on demo painful — every push to main,
every cron tick, and every dispatch of main re-aliases demo back to main.

To hold demo on a feature branch:

```bash
# Pin demo to your branch
echo my-feature-branch > .github/demo-pin.txt
git add .github/demo-pin.txt
git commit -m "demo: pin to my-feature-branch"
git push origin main

# Dispatch a demo deploy of that branch
gh workflow run "Deploy Demo Site" --ref main -f ref=my-feature-branch
```

While the pin is set:

| Trigger | Builds? | Aliases demo? |
|---|---|---|
| dispatch with ref=my-feature-branch | yes | yes |
| push to main / cron / dispatch with ref=main | yes | no |
| dispatch with a different ref | yes | no |

Non-aliased deploys still produce a preview URL — just no alias change.

To release the pin:

```bash
> .github/demo-pin.txt
git add .github/demo-pin.txt
git commit -m "demo: unpin"
git push origin main
```

The next push / cron / dispatch will alias demo to main as normal.
