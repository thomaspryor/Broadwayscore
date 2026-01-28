# AI Feedback on Plan

**Generated:** 2026-01-28T21:56:59.506Z
**Plan file:** docs/biz-section-plan.md

---

## Claude (Sonnet) Feedback

## My Recommendation

**Option B** - Dashboard + Deep Dives. Here's why:

Option A is too minimal given your unique data advantage. Option C spreads the same information too thin across too many pages. Option B gives you focused real estate to showcase your competitive moat while keeping navigation simple.

## Cut These Features

- **Separate `/biz/recoupment` and `/biz/investments` pages** - This data works better combined in a single dashboard view
- **Progress bars for TBD shows** - False precision kills credibility with industry insiders. Stick to percentage ranges as text
- **Color-coded "on-track/at-risk" status** - Your audience can interpret the numbers themselves

## Missing High-Value Feature

**ROI comparison table** showing actual returns for recouped shows. Calculate: (Total Gross - Running Costs × Weeks - Capitalization) ÷ Capitalization. This is the metric investors actually care about but can never find. You have all the data needed.

Also add **"Capital at Risk"** prominently on the dashboard - sum of investments for all currently running TBD shows. Industry people love this number.

## Red Flags

**Don't create separate `/biz/[slug]` pages.** Your show pages already exist - just enhance the "Commercial Scorecard" card with more detail (full notes, sources, week-by-week recoupment progress if available). Creating parallel navigation confuses users.

**Technical concern:** With static export, make sure your sortable tables work without JavaScript for core functionality. Industry users often browse on locked-down devices.

**UX concern:** Lead with the money. Your dashboard should open with the most shocking stats first - total capital deployed, recoupment rate, biggest winners/losers. Bury methodology explanations below the fold.

The `/biz` dashboard becomes your showcase page, individual show deep-dives happen on existing show pages, and you avoid over-engineering a simple value proposition.

---

## GPT-4o Feedback

1. **Recommendation**: Option B is the best balance between value and complexity. It addresses the need for more detail than Option A while avoiding the potential over-engineering of Option C. With Option B, you get a comprehensive dashboard and the ability to offer deeper insights on an individual show basis without overwhelming users with too many sections.

2. **Cut**: Removing the `/biz/investments` page from Option C is advisable. The investment comparison by budget tier may not provide significant additional insights compared to detailed recoupment and capitalization data, which are prioritized by the audience. Also, avoid progress bars for estimated recoupment percentages on the basis of their potential to mislead with false precision.

3. **Missing**: Introduce a simple aggregate comparison view for investment vs. revenue, potentially as a feature in Option B's dashboard. This insight would be highly valued for understanding profitability patterns and can be developed with relatively low effort using existing data fields such as gross, capitalization, and recoupment status.

4. **Red flags**: Ensure that mobile responsiveness does not compromise the clarity of data presentation, as industry insiders may access data across devices. In terms of technical constraints, rely on static JSON data to design the dashboard dynamically, adhering to Next.js's limitations. Be cautious of overcomplicating navigation with multiple, similar types of pages, which may discourage use—especially with "/biz" already covering substantial ground.

---

## Gemini 2.0 Flash Feedback

Okay, here's my review:

1.  **Recommendation:** Option B. It's a good balance between providing valuable insights and not overcomplicating the development process. Option A is too minimal, and Option C risks feature bloat without a clear understanding of user needs.

2.  **Cut:** Initially, cut the "Investment comparison by budget tier" section (from Option C). It feels like an assumption about what users want; validate this need later. Focus on core recoupment tracking first.

3.  **Missing:** A simple data download option (CSV/JSON) for users to do their own analysis. This is *very* high-value and *very* low-effort given your existing JSON data structure. Consider requiring registration (email) to access the download for lead generation.

4.  **Red flags:**
    *   **Static Export Limitation:** Heavily limits interactivity. Consider carefully whether a fully static site truly meets industry insider's needs for data exploration. Can you pre-generate enough variations to satisfy most queries, or should you rethink this constraint? Explore serverless functions if interactivity is truly desired.
    *   **"Estimated Recoupment Percentage":** Using just a range is weak. Implement color-coding (on-track/at-risk) *with* the range. Make the criteria for "on-track" explicit (e.g., projected recoupment within X weeks based on current run rate).
    *   **Source Reliability:** "Reddit analysis" as a source is concerning. Ensure all data is thoroughly vetted and clearly indicate source reliability (e.g., clearly mark data coming from SEC filings vs. estimates).

Good luck.


