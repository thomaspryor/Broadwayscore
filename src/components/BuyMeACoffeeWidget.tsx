export function BuyMeACoffeeWidget({ siteName = 'Broadway Scorecard' }: { siteName?: string }) {
  return (
    <div className="card p-6 sm:p-8 mb-6 text-center">
      <p className="text-gray-300 mb-5">
        If {siteName} has helped you pick your next show:
      </p>
      <a
        href="https://buymeacoffee.com/broadwayscorecard"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-6 py-3 rounded-lg font-semibold text-gray-900 transition-colors"
        style={{ backgroundColor: '#FFDD00' }}
      >
        <svg width="20" height="20" viewBox="0 0 884 1279" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M792.4 1003.2H791.1C791.1 1003.2 476 1278.2 442.2 1278.2C408.4 1278.2 93.3 1003.2 93.3 1003.2H92C41.2 1003.2 0 962 0 911.2V215.8C0 207.4 6.8 200.6 15.2 200.6H869.2C877.6 200.6 884.4 207.4 884.4 215.8V911.2C884.4 962 843.2 1003.2 792.4 1003.2Z" fill="#0D0C22"/>
          <path d="M297.1 397.8C297.1 397.8 306 183.6 535.9 91.8C535.9 91.8 427 225.8 442.7 397.8H297.1Z" fill="#FF813F"/>
          <path d="M619.1 397.8C619.1 397.8 612.2 249.2 727.3 91.8C727.3 91.8 672 174.4 665.2 397.8H619.1Z" fill="#FF813F"/>
          <path d="M792.4 1003.2H791.1C791.1 1003.2 476 1278.2 442.2 1278.2C408.4 1278.2 93.3 1003.2 93.3 1003.2H92C41.2 1003.2 0 962 0 911.2V571.6H884.4V911.2C884.4 962 843.2 1003.2 792.4 1003.2Z" fill="white"/>
          <path d="M442.2 1048C476 1048 524 873 524 873H360.4C360.4 873 408.4 1048 442.2 1048Z" fill="#FF813F"/>
        </svg>
        Buy me a coffee
      </a>
    </div>
  );
}
