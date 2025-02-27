import { Button } from '@blueprintjs/core'
import ReactTextareaAutocomplete from '@webscopeio/react-textarea-autocomplete'
import cx from 'classnames'
import isEmpty from 'lodash/isEmpty'
import React, { FC, useEffect, useState } from 'react'

import { IAutoComplete, IShortcut } from '../../config'
import { makeClient } from '../client'
import lang from '../lang'

import style from './style.scss'

// store here is the whole webchat store
// reference here: modules/channel-web/src/views/lite/store/index.ts
interface ComposerProps {
  name: string
  store: {
    bp: any
    composer: any
    sendMessage: () => Promise<void>
  }
}

interface ShortcutItemProps {
  selected: boolean
  trigger: string
  entity: IShortcut
}
const ShortcutItem: FC<ShortcutItemProps> = props => (
  <div className={cx(style.shortcutItem, { [style.selected]: props.selected })}>
    <span className={style.shortcutKey}>{`${props.trigger}${props.entity.name}`}</span>
    <span className={style.shortcutValue}>{`${props.entity.value}`}</span>
  </div>
)

const ShortcutComposer: FC<ComposerProps> = props => {
  const [autoComplete, setAutoComplete] = useState<IAutoComplete>()
  const [isLoading, setIsLoading] = useState(true)
  const [text, setText] = useState<string>('')

  const hitlClient = makeClient(props.store.bp)

  const fetchShortcuts = async () => {
    try {
      const configs = await hitlClient.getConfig()
      setAutoComplete(configs.autoComplete)
    } catch {
      console.error('could not fetch module config')
    }
  }

  useEffect(() => {
    // tslint:disable-next-line: no-floating-promises
    fetchShortcuts().finally(() => setIsLoading(false))
  })

  const sendMessage = async (): Promise<void> => {
    if (!canSendText()) {
      return
    }

    props.store.composer.updateMessage(text.trim())
    await props.store.sendMessage()
    setText('')
  }

  const handleChange: React.ChangeEventHandler<HTMLTextAreaElement> = event => {
    setText(event.target.value)
  }

  const handleKeyDown: React.EventHandler<React.KeyboardEvent> = event => {
    if (event.shiftKey) {
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault() // prevent \n
      sendMessage().catch(() => console.error('could not send message'))
    }
  }

  const canSendText = (): boolean => text.trim().length > 0

  return (
    !isLoading &&
    !isEmpty(autoComplete) && (
      <div id="shortcutContainer" className={style.composerContainer}>
        <ReactTextareaAutocomplete
          containerClassName={cx('bpw-composer', style.composer)}
          className={'bpw-composer-inner'}
          dropdownClassName={style.shortcutDropdown}
          itemClassName={style.shortcutListItem}
          loadingComponent={() => null}
          minChar={0}
          placeholder={lang.tr('module.hitlnext.conversation.composerPlaceholder')}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          scrollToItem={false}
          trigger={{
            [autoComplete.trigger]: {
              dataProvider: (token: string) => autoComplete.shortcuts.filter(s => s.name.toLowerCase().includes(token)),
              component: props => <ShortcutItem {...props} trigger={autoComplete.trigger} />,
              output: (s: IShortcut) => s.value
            }
          }}
        />
        <Button className={style.sendButton} disabled={!canSendText()} onClick={sendMessage}>
          {lang.tr('module.hitlnext.conversation.send')}
        </Button>
      </div>
    )
  )
}

export default ShortcutComposer
