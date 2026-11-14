export interface ScrapedProductData {
  url: string;
  title: string | null;
  price: number | null;
  inStock: boolean;
  rawPriceText?: string | null;
  error?: string;
}

export interface IScraper {
  scrapeProduct(url: string): Promise<ScrapedProductData>;
  close(): Promise<void>;
}
