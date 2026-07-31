import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { X } from 'lucide-react';

export function Modal({ open, onOpenChange, title, description, children, wide = false }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: React.ReactNode; wide?: boolean;
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal>
    <Dialog.Overlay className="dialog-overlay" />
    <Dialog.Content className={`dialog-content ${wide ? 'dialog-wide' : ''}`}>
      <div className="dialog-heading"><div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div>
        <Dialog.Close className="icon-button" aria-label="关闭"><X size={18} /></Dialog.Close></div>
      {children}
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, danger = false, onConfirm }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; confirmLabel: string; danger?: boolean; onConfirm: () => void | Promise<void>;
}) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}><AlertDialog.Portal>
    <AlertDialog.Overlay className="dialog-overlay" />
    <AlertDialog.Content className="dialog-content confirm-dialog">
      <AlertDialog.Title>{title}</AlertDialog.Title><AlertDialog.Description>{description}</AlertDialog.Description>
      <div className="dialog-actions"><AlertDialog.Cancel className="secondary-button">取消</AlertDialog.Cancel>
        <AlertDialog.Action className={danger ? 'danger-button' : 'primary-button'} onClick={onConfirm}>{confirmLabel}</AlertDialog.Action></div>
    </AlertDialog.Content>
  </AlertDialog.Portal></AlertDialog.Root>;
}
