import { isFlatMemory, memoryCategories, type StoredMemoryDocument } from '../shared/memory';
export function MemoryRecords({ document }: { document: StoredMemoryDocument }) {
  const list = (items: { id: string; text: string }[]) => items.length
    ? <ul>{items.map(item => <li key={item.id}>{item.text}</li>)}</ul>
    : <p className="note">Nothing recorded.</p>;
  return isFlatMemory(document) ? list(document.database_records) : <>{memoryCategories.map(category =>
    <section key={category}><h3>{category[0].toUpperCase()+category.slice(1)}</h3>{list(document[category])}</section>)}</>;
}
