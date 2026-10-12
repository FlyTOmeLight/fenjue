export async function collect(fetchPage, size) {
  const { items } = await fetchPage(null, size);
  return items;
}
