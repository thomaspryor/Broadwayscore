'use client';

export function BuyMeACoffeeWidget() {
  return (
    <div className="card p-6 sm:p-8 mb-6">
      <p className="text-gray-300 mb-5 text-center">
        If Broadway Scorecard has helped you pick your next show:
      </p>
      <div className="flex justify-center">
        <iframe
          src="https://www.buymeacoffee.com/widget/page/broadwayscorecard?description=&color=%23FFDD00"
          title="Buy Me a Coffee"
          className="rounded-xl border-0"
          style={{ width: '100%', maxWidth: 360, height: 500 }}
        />
      </div>
    </div>
  );
}
