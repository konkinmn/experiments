interface HeaderProps {
  title: string;
}

export function Header({ title }: HeaderProps) {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
    </div>
  );
}
