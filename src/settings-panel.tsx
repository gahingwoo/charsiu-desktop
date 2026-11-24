// The settings panel, in place of the conversation, as the Chatbot extension's
// "Fullscreen chatbot with docked navigation" demo draws its own
// (FullscreenDockedNav.tsx in @patternfly/chatbot 6.9.0): a title with a close
// button, a divider, then plain rows of label and control.
// SPDX-License-Identifier: GPL-2.0-only
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Button, Divider, Dropdown, DropdownItem, DropdownList, Flex, MenuToggle, Title, Tooltip,
} from '@patternfly/react-core';
import { RhMicronsCloseIcon } from '@patternfly/react-icons/dist/esm/icons/rh-microns-close-icon';
import { useI18n } from './i18n';
import { LANG_NAMES, LANGS } from './i18n-core';
import type { Settings } from './api';

interface PlainTextSettingsFormProps {
  fields: { id: string; label: string; field: ReactNode }[];
}

const PlainTextSettingsForm = ({ fields }: PlainTextSettingsFormProps) => (
  <div className="pf-chatbot__settings-form-container">
    <form className="pf-chatbot__settings-form" onSubmit={(e) => e.preventDefault()}>
      {fields.map(({ id, label, field }) => (
        <div className="pf-chatbot__settings-form-row" key={id}>
          <div className="pf-chatbot__settings-label" id={`${id}-label`}>
            {label}
          </div>
          {field}
        </div>
      ))}
    </form>
  </div>
);

export interface ModelChoice { value: string; label: string }

export function SettingsPanel({ settings, setSettings, models, model, onModel, canRestart, onClose, onManageModels, onAdvanced, onRestart, onReport, onAbout }: {
  settings: Settings; setSettings: (s: Settings) => void;
  models: ModelChoice[]; model: string; onModel: (v: string) => void; canRestart: boolean;
  onClose: () => void; onManageModels: () => void; onAdvanced: () => void; onRestart: () => void; onReport: () => void; onAbout: () => void;
}) {
  const { t } = useI18n();
  const [openDropdown, setOpenDropdown] = useState<string>();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
  }, []);

  const dropdownField = (id: string, label: string, value: string, options: ModelChoice[], onSelect: (v: string) => void) => (
    <Dropdown
      isOpen={openDropdown === id}
      onSelect={(_event, selectedValue) => {
        onSelect(String(selectedValue));
        setOpenDropdown(undefined);
      }}
      onOpenChange={(isOpen: boolean) => setOpenDropdown(isOpen ? id : undefined)}
      shouldFocusToggleOnSelect
      shouldFocusFirstItemOnOpen
      popperProps={{ position: 'end' }}
      toggle={(toggleRef) => (
        <MenuToggle
          id={id}
          ref={toggleRef}
          onClick={() => setOpenDropdown(openDropdown === id ? undefined : id)}
          isExpanded={openDropdown === id}
          aria-label={`${options.find((o) => o.value === value)?.label ?? value}, ${label}`}
        >
          {options.find((o) => o.value === value)?.label ?? value}
        </MenuToggle>
      )}
    >
      <DropdownList>
        {options.map((option) => (
          <DropdownItem value={option.value} key={option.value}>
            {option.label}
          </DropdownItem>
        ))}
      </DropdownList>
    </Dropdown>
  );

  const fields = [
    { id: 'model', label: t('model.label'), field: dropdownField('model', t('model.label'), model, models, onModel) },
    { id: 'models', label: t('settings.modelFiles'), field: <Button id="models" onClick={onManageModels}>{t('settings.manage')}</Button> },
    {
      id: 'theme',
      label: t('settings.theme'),
      field: dropdownField('theme', t('settings.theme'), settings.theme, [
        { value: 'system', label: t('settings.themeSystem') },
        { value: 'light', label: t('settings.themeLight') },
        { value: 'dark', label: t('settings.themeDark') },
      ], (v) => setSettings({ ...settings, theme: v as Settings['theme'] })),
    },
    {
      id: 'language',
      label: t('settings.language'),
      field: dropdownField('language', t('settings.language'), settings.language, [
        { value: '', label: t('settings.langAuto') },
        ...LANGS.map((l) => ({ value: l, label: LANG_NAMES[l] })),
      ], (v) => setSettings({ ...settings, language: v })),
    },
    { id: 'advanced', label: t('settings.advanced'), field: <Button id="advanced" onClick={onAdvanced}>{t('settings.edit')}</Button> },
    { id: 'restart', label: t('menu.restart'), field: <Button id="restart" onClick={onRestart} isDisabled={!canRestart}>{t('settings.restart')}</Button> },
    { id: 'report', label: t('menu.report'), field: <Button id="report" onClick={onReport}>{t('settings.report')}</Button> },
    { id: 'about', label: t('menu.about'), field: <Button id="about" onClick={onAbout}>{t('settings.view')}</Button> },
  ];

  return (
    <div className="pf-v6-u-w-100">
      <div className="pf-v6-u-w-100 pf-v6-u-mx-auto" style={{ maxWidth: '60rem' }}>
        <Flex
          justifyContent={{ default: 'justifyContentSpaceBetween' }}
          alignItems={{ default: 'alignItemsCenter' }}
          className="pf-v6-u-p-lg"
        >
          <Title headingLevel="h1" size="2xl">
            {t('settings.title')}
          </Title>
          <Tooltip triggerRef={closeButtonRef} content={t('settings.close')} position="bottom" aria="none" />
          <Button
            ref={closeButtonRef}
            variant="plain"
            icon={<RhMicronsCloseIcon />}
            aria-label={t('settings.close')}
            onClick={onClose}
          />
        </Flex>
        <Divider />
        <PlainTextSettingsForm fields={fields} />
      </div>
    </div>
  );
}
